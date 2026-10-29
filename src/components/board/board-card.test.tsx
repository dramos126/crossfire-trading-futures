// @vitest-environment jsdom
/**
 * The board card as a book, and the hand-made card beside it.
 *
 * Two things are pinned and they are one rule each. **A book card is an
 * account**: its header says so and carries the budget, its
 * rows name playbooks and carry none, and it wears no stamp — `GRP` means
 * *this deployment fans across accounts* and stays on the card that does.
 * And **the controls the routes refuse are inert rather than live**: a
 * deployment a book materialised is refused by `DELETE /api/groups/[id]`, by
 * the group `PATCH`'s enable arm and by `PATCH /api/deployments/[id]`, all
 * with `BOOK_DERIVED_ROW_REFUSAL`, so a live glyph there offers a press whose
 * only outcome is an error box.
 *
 * The DOM is what makes it observable — `disabled` and `title` on a rendered
 * button, per [testing/patterns.md](../../docs/modules/testing/patterns.md).
 * The fixtures come out of the shipped `buildBoard` rather than hand-written
 * `BoardDeployment` literals, so the adapter and the assertion cannot drift.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HIDE_ACCOUNT_IDS_KEY,
  HIDE_BALANCES_KEY,
  MASKED_USD,
} from "@/components/privacy/privacy-model";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BOOK_CARD_EDIT_REASON,
  buildBoard,
  type BoardAccount,
  type BoardDeployment,
  type BoardInput,
  type BoardLegRisk,
} from "./board-model";
import {
  BALANCE_NEVER_READ,
  boardAccountStatus,
  describeOrphanReason,
  DETACHED_RECOVER_LABEL,
  DETACHED_RECOVER_NOTE,
  DETACHED_RESUME_REFUSAL,
  formatUsd,
  TOTAL_UNPRICED,
  UNREALIZED_UNPRICED,
} from "./board-view";
import {
  BOOK_DERIVED_ROW_REFUSAL,
  RESTORE_NEEDS_PLAYBOOK_ON,
  RESTORE_WOULD_RETRACT_A_CLOSE,
} from "@/lib/trading/domain";
import type { Deployment, DeploymentGroup } from "@/lib/trading/domain";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import { LIVE_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import type { AccountStatusWire } from "@/app/api/accounts/status/route";
import {
  ACCOUNT_DEAD_REFUSAL,
  ACCOUNT_STATE_STAMP,
  lockedRefusal,
} from "@/lib/trading/broker-access/account-state-gate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

// The card's data sources are hooks over a session and the deployment store;
// neither is what this file is about, and no test here presses a live control.
// `accounts` is the catalogue the privacy provider numbers; only the
// display-privacy tests mount the provider.
const catalogue = vi.hoisted(() => ({ accounts: [] as Array<{ id: number; name: string }> }));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ token: "test-token", practiceOnly: false, accounts: catalogue.accounts }),
}));

vi.mock("@/lib/hooks/use-strategies", () => ({
  useDeployments: () => ({ toggleDeployment: vi.fn(), deleteDeployment: vi.fn() }),
  loadDeployments: () => [],
  refreshDeployments: vi.fn(),
  syncEngine: vi.fn(),
}));

const { BoardCard, partitionPhoneRows, PHONE_FLAT_HIDE, PHONE_FLAT_SHOW } = await import("./board-card");
const { FlattenAllButton } = await import("@/components/flatten-all-button");
const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");

// ── Fixtures ────────────────────────────────────────────────────────────

/** A real Topstep practice name, per the prefix table in
 *  docs/modules/brokers/topstep.md — `PRAC-` is permitted to auto-trade. */
const ACCOUNT: BoardAccount = {
  id: 5001,
  name: "PRAC-V2-100200-90012114",
  broker: "topstep",
  practice: true,
  autoTrade: { permitted: true },
};

const OTHER_ACCOUNT: BoardAccount = {
  id: 5002,
  name: "PRAC-V2-100200-90020038",
  broker: "topstep",
  practice: true,
  autoTrade: { permitted: true },
};

function emptyPnl(): PnLBreakdown {
  return { realized: 0, unrealized: 0, fees: 0, total: 0, closedCount: 0, hasOpenPosition: false };
}

/** The brand is asserted visibly, the way `board-model.test.ts` does it. */
function selector(answer: (id: string) => PnLBreakdown | null): BoardInput["sessionPnl"] {
  return answer as BoardInput["sessionPnl"];
}

const SESSION = { start: "09:30", end: "15:55", timezone: "America/New_York" } as const;

const STRATEGIES: Record<string, { name: string; timeframe: string }> = {
  "ema-crossover": { name: "EMA Crossover", timeframe: "5m" },
  orb: { name: "Opening Range Breakout", timeframe: "5m" },
  "ema-bounce": { name: "EMA Bounce", timeframe: "1m" },
};

function leg(
  id: string,
  groupId: string,
  strategyKey: string,
  accountId = ACCOUNT.id,
  detached: { reason: string } | null = null,
  /** Overridden only by the closing fixtures — `markOrphaned` preserves
   *  `Pausing` / `Destroying`, so detached and mid-close is a real row. */
  status?: Deployment["status"],
): Deployment {
  return {
    id,
    strategyKey,
    accountId,
    ticker: "/MNQ",
    contractId: null,
    status: status ?? (detached ? "Paused" : "Active"),
    paramValues: {},
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    orphanedAt: detached ? "2026-09-17T05:21:10.122Z" : null,
    orphanReason: detached?.reason ?? null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId,
    enabledSnapshot: null,
  };
}

function parent(id: string, strategyKey: string, bookId: string | null): DeploymentGroup {
  return {
    id,
    name: null,
    strategyKey,
    paramValues: {},
    ticker: "/MNQ",
    contractId: null,
    enabled: true,
    bookId,
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    deletedAt: null,
  };
}

/** A budget with something to read, so the cell's *slot* is what the tests
 *  about it are asserting rather than which arm it landed in. */
const BUDGET: BoardLegRisk = {
  kind: "budget",
  amount: "$500",
  note: "Combine",
  tone: "muted",
  detail: "Every deployment on this account is sized to this same budget.",
};

function build(args: {
  groups: DeploymentGroup[];
  deployments: Deployment[];
  accounts?: BoardAccount[];
  groupByBook: boolean;
  accountStatus?: BoardInput["accountStatus"];
  sessionPnl?: (id: string) => PnLBreakdown | null;
}): BoardDeployment[] {
  return buildBoard({
    deployments: args.deployments,
    groups: args.groups,
    accounts: args.accounts ?? [ACCOUNT],
    trades: [],
    strategy: (key) =>
      STRATEGIES[key] ? { ...STRATEGIES[key], session: SESSION } : null,
    sessionPnl: selector(args.sessionPnl ?? (() => emptyPnl())),
    regime: () => null,
    risk: () => BUDGET,
    accountStatus: args.accountStatus,
    groupByBook: args.groupByBook,
  });
}

/** One book, two armed playbooks, one account — the shape the board renders
 *  once a book has materialised. */
function bookCard(accountStatus?: BoardInput["accountStatus"]): BoardDeployment {
  return build({
    groups: [parent("grp-orb", "orb", "book-1"), parent("grp-ema", "ema-bounce", "book-1")],
    deployments: [leg("leg-orb", "grp-orb", "orb"), leg("leg-ema", "grp-ema", "ema-bounce")],
    groupByBook: true,
    accountStatus,
  })[0];
}

/** 2026-10-21 18:30 ET, the evening after a 17:55 check. */
const STATUS_NOW = new Date("2026-10-21T22:30:00.000Z");

/** The account status as the shipped producer reads one stored row. */
function statusOf(row: Partial<AccountStatusWire> = {}): BoardInput["accountStatus"] {
  return boardAccountStatus({
    rows: [
      {
        accountId: ACCOUNT.id,
        broker: "topstep",
        balanceUsd: 48_722.9,
        balanceAt: "2026-10-21T21:55:01.000Z",
        checkedAt: "2026-10-21T21:55:03.000Z",
        refusal: null,
        ...row,
      },
    ],
    failed: false,
    now: STATUS_NOW,
  });
}

/**
 * The A74 shape: one leg, orphan-paused by a boot inside the maintenance
 * window, on an account that was live at the broker the whole time — which is
 * why `ACCOUNT` is still in the catalogue here.
 */
function detachedCard(reason = "account_unavailable_at_boot"): BoardDeployment {
  return build({
    groups: [parent("grp-orb", "orb", null)],
    deployments: [leg("leg-orb", "grp-orb", "orb", ACCOUNT.id, { reason })],
    groupByBook: false,
  })[0];
}

/**
 * The row C1 is about: detached **and** still closing. The closing guard's own
 * `placeOrder` answered `AccountNotFound`, which orphaned the row, and
 * `markOrphaned` kept the `Destroying` because the close is owed whether or
 * not the account answers.
 */
function detachedClosingCard(): BoardDeployment {
  return build({
    groups: [parent("grp-orb", "orb", null)],
    deployments: [
      leg(
        "leg-orb",
        "grp-orb",
        "orb",
        ACCOUNT.id,
        { reason: "place_order_account_not_found" },
        "Destroying",
      ),
    ],
    groupByBook: false,
  })[0];
}

/**
 * The A85 shape: a book's row, detached, under a parent the book has switched
 * off — the A83 state plus a boot account check that missed the account.
 */
function detachedBookCard(parentEnabled: boolean): BoardDeployment {
  return build({
    groups: [{ ...parent("grp-orb", "orb", "book-1"), enabled: parentEnabled }],
    deployments: [
      leg("leg-orb", "grp-orb", "orb", ACCOUNT.id, { reason: "account_unavailable_at_boot" }),
    ],
    groupByBook: true,
  })[0];
}

/** A hand-made deployment fanned across two accounts, which is what `GRP`
 *  means and what a book never is. */
function handMadeCard(): BoardDeployment {
  return build({
    groups: [parent("grp-1", "ema-crossover", null)],
    deployments: [
      leg("leg-1", "grp-1", "ema-crossover"),
      leg("leg-2", "grp-1", "ema-crossover", OTHER_ACCOUNT.id),
    ],
    accounts: [ACCOUNT, OTHER_ACCOUNT],
    groupByBook: true,
  })[0];
}

// ── Harness ─────────────────────────────────────────────────────────────

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(ui: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

/** The header's control cluster, by the glyph it renders. Scoped to `header`
 *  so a leg row's own ⏸ — which this change deliberately does not touch —
 *  cannot answer for the card's. */
function headerControl(glyph: string): HTMLButtonElement {
  const hit = Array.from(container!.querySelectorAll<HTMLButtonElement>("header button")).find(
    (b) => b.textContent?.includes(glyph),
  );
  if (!hit) throw new Error(`no header control carrying ${glyph}`);
  return hit;
}

/** The same glyph on the leg row, which is everything the header is not — the
 *  two are separate controls over separate routes and each owes the refusal. */
function legControl(glyph: string): HTMLButtonElement {
  const hit = Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.closest("header") == null && b.textContent?.includes(glyph),
  );
  if (!hit) throw new Error(`no leg control carrying ${glyph}`);
  return hit;
}

function stamps(): string[] {
  return Array.from(container!.querySelectorAll("header span")).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

/** Every row of the card, in rendered order — the ▸ links, which are the rows.
 *  Scoped outside `header` so the ✎'s own `/deployments/…` link cannot pass
 *  for one. */
function rows(): HTMLAnchorElement[] {
  return Array.from(
    container!.querySelectorAll<HTMLAnchorElement>('[data-board-rows="desk"] a[href^="/deployments/"]'),
  ).filter((a) => a.closest("header") == null);
}

/** The phone's row list, in DOM order — the same ▸ links, below `sm` only. */
function phoneRows(): HTMLAnchorElement[] {
  return Array.from(
    container!.querySelectorAll<HTMLAnchorElement>('[data-board-rows="phone"] a[href^="/deployments/"]'),
  );
}

/**
 * The card's text as one breakpoint shows it. jsdom applies no media queries,
 * so this strips what the class pair hides there: `sm:hidden` on the desk, a
 * base `hidden` on a phone.
 */
function textAt(bp: "phone" | "desk"): string {
  const clone = container!.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    if (el.classList.contains(bp === "desk" ? "sm:hidden" : "hidden")) el.remove();
  }
  return clone.textContent ?? "";
}

/** The nearest phone-hidden ancestor-or-self, which must be desk-visible. */
function deskOnlyWrapper(el: Element): Element | null {
  return el.closest(".hidden");
}

/** The header's own text, which is where the budget belongs on a book card
 *  and where it must never appear on a hand-made one. */
function headerText(): string {
  return container!.querySelector("header")?.textContent ?? "";
}

/** The recovery control, found by the text that *is* its accessible name —
 *  it carries no `aria-label`, because the label changes while the press is
 *  out and a static one would freeze a stale name into the DOM for a test's
 *  benefit ([testing/patterns.md]). */
function recoverButton(): HTMLButtonElement | null {
  return (
    Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === DETACHED_RECOVER_LABEL || b.textContent === "Restoring…",
    ) ?? null
  );
}

type RecordedCall = { url: string; method: string };

/**
 * `fetch` as a recorder. The preflight behind the activation prompts answers
 * "cannot say", which is prompt 2's could-not-check form; a stubbed `confirm`
 * answers both prompts.
 */
function stubFetch(clearOrphan: {
  ok: boolean;
  status?: number;
  body: unknown;
}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("clear-orphan")) {
        return {
          ok: clearOrphan.ok,
          status: clearOrphan.status ?? 200,
          json: async () => clearOrphan.body,
        };
      }
      return { ok: true, status: 200, json: async () => ({ available: false }) };
    }),
  );
  return calls;
}

/** A press, then the two flushes an awaited handler needs — the prompt's own
 *  preflight resolves on the first and the render lands on the second. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("BoardCard — a book is one card and its rows are playbooks", () => {
  it("titles itself with the account alone, and wears no stamp", () => {
    // The header is the identity, so a `BOOK` stamp beside it would be a
    // second spelling of the line it sits on — and `GRP` is a different claim
    // (*this deployment fans across accounts*) that is false of every book.
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    expect(headerText()).toContain(ACCOUNT.name);
    expect(headerText()).not.toContain("/MNQ");
    expect(stamps()).not.toContain("BOOK");
    expect(stamps()).not.toContain("GRP");
  });

  it("folds its rows onto the header when collapsed, and the account name opens it", () => {
    const pressed: string[] = [];
    mount(
      <BoardCard card={bookCard()} onMutated={() => {}} expanded={false} onToggleExpanded={(id) => pressed.push(id)} />,
    );

    expect(rows()).toHaveLength(0);
    expect(headerText()).toContain(ACCOUNT.name);
    const fold = container!.querySelector<HTMLButtonElement>("header button[aria-expanded]")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    act(() => fold.click());
    expect(pressed).toEqual([bookCard().id]);
  });

  it("renders one row per playbook, each linking to its own derived row's page", () => {
    // The ▸ is what answers *what has this playbook done on this account*, and
    // it is that row's deployment rather than the book's — the book has no
    // page and needs none.
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    expect(rows().map((a) => a.getAttribute("href"))).toEqual([
      "/deployments/leg-ema",
      "/deployments/leg-orb",
    ]);
    expect(rows().map((a) => a.textContent)).toEqual([
      expect.stringContaining("EMA Bounce"),
      expect.stringContaining("Opening Range Breakout"),
    ]);
    // A book spans contracts, so each row names its own.
    expect(rows().every((a) => a.textContent?.startsWith("MNQ"))).toBe(true);
    expect(rows()[0].getAttribute("aria-label")).toBe("Open EMA Bounce on MNQ's history and stats");
    // The account is the card's and it is named once, in the header. A row
    // repeating it would be the column the book grouping took out.
    expect(rows().some((a) => a.textContent?.includes(ACCOUNT.name))).toBe(false);
  });

  it("states the budget in the header and on neither row", () => {
    // One account, one figure, no arithmetic: the header *is* the surface that
    // names the account here. A cell on a playbook row would say each playbook
    // has a budget of its own, which is the misreading the `DL` / `DP` chips
    // came off the identity line for.
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    expect(headerText()).toContain("Risk/trade:");
    expect(headerText()).toContain("$500");
    const rowText = rows().map((a) => a.textContent ?? "");
    expect(rowText.some((t) => t.includes("Risk/trade"))).toBe(false);
    // Once per breakpoint: the desk's title line, or the phone's third line.
    expect(textAt("desk").match(/\$500/g)).toHaveLength(1);
    expect(textAt("phone").match(/\$500/g)).toHaveLength(1);
  });

  it("renders ✕ inert with the refusal, rather than a button that 409s", () => {
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    const destroy = headerControl("✕");
    expect(destroy.disabled).toBe(true);
    expect(destroy.getAttribute("title")).toBe(BOOK_DERIVED_ROW_REFUSAL);
  });

  it("renders the card's ⏸ inert with the same sentence, still stating the switch position", () => {
    // Same refusal, same constant: the group `PATCH`'s enable arm answers it
    // too, so a live toggle here is the other half of the same defect.
    //
    // `headerControl("⏸")` is half the assertion. An inert intent is neither
    // `pause` nor `resume`, so a glyph read off the intent alone renders ▶ over
    // a book that is trading — a greyed play button claiming a running card is
    // paused.
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    const toggle = headerControl("⏸");
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("title")).toBe(BOOK_DERIVED_ROW_REFUSAL);
    expect(headerText()).not.toContain("▶");
  });

  it("renders every row's own ⏸ inert too, and no ▶ over a running row", () => {
    // `PATCH /api/deployments/[id]` 409s on a status write to any leg of a
    // derived row, so each row owes the same refusal the header does — through
    // `legToggleIntent`, which is handed the card's `bookId`.
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    const toggles = Array.from(
      container!.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((b) => b.closest("header") == null && b.textContent?.includes("⏸"));
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle.disabled).toBe(true);
      expect(toggle.getAttribute("title")).toBe(BOOK_DERIVED_ROW_REFUSAL);
    }
    expect(container!.textContent).not.toContain("▶");
  });

  it("renders the ✎ inert, saying the configuration is each playbook's own", () => {
    // A book card is not a deployment, so a card-level edit link has no
    // subject — one `✎` over two playbooks would be one row's settings
    // printed over a header that spans both. The control stays visible and
    // names where the settings are, and the sentence is **not** the broken
    // row's, which would say the configuration is gone.
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    expect(container!.querySelector('header a[aria-label="Edit deployment"]')).toBeNull();
    const edit = container!.querySelector("header span[aria-disabled]");
    expect(edit?.getAttribute("title")).toBe(BOOK_CARD_EDIT_REASON);
  });
});

describe("BoardCard — a book card states its account's balance and state", () => {
  /** The header element whose `title` carries the given text. */
  const titled = (text: string) =>
    Array.from(container!.querySelectorAll<HTMLElement>("header [title]")).find((el) =>
      el.getAttribute("title")?.includes(text),
    );

  it("states the balance in the header, titled with when it was read", () => {
    mount(<BoardCard card={bookCard(statusOf())} onMutated={() => {}} />);

    expect(headerText()).toContain("Balance:");
    expect(headerText()).toContain("$48,722.90");
    expect(titled("Balance as of 17:55 ET")?.textContent).toContain("$48,722.90");
  });

  it("names the day on a balance from an earlier day, so a stale read shows its age", () => {
    mount(<BoardCard card={bookCard(statusOf({ balanceAt: "2026-10-20T21:55:01.000Z" }))} onMutated={() => {}} />);

    expect(titled("Balance as of Oct 20, 17:55 ET")).toBeDefined();
  });

  it("renders an em-dash with its reason when no balance is stored, never $0.00", () => {
    mount(<BoardCard card={bookCard(statusOf({ balanceUsd: null, balanceAt: null }))} onMutated={() => {}} />);

    // The session P&L's own `$0.00` sits on the meta line; the balance cell is
    // the one asserted on.
    expect(titled(BALANCE_NEVER_READ)?.textContent).toBe("Balance:—");
  });

  it("wears the account-state stamp with the gate's reason when the account is refused", () => {
    const refusal = { kind: "dead" as const, stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL };
    mount(<BoardCard card={bookCard(statusOf({ refusal }))} onMutated={() => {}} />);

    const stamp = titled(ACCOUNT_DEAD_REFUSAL);
    expect(stamp?.textContent).toBe("Dead");
    expect(stamp?.className).toContain("rounded-full");
  });

  // The string's own casing is what renders: `DLL`, not `dll`, and not `LOCKED`.
  it("renders a cause stamp in the casing it is written in", () => {
    const reason = lockedRefusal("daily loss limit reached: lost $1,041.66 of a $1,000.00 limit today", null);
    mount(<BoardCard card={bookCard(statusOf({ refusal: { kind: "locked", stamp: "DLL", reason } }))} onMutated={() => {}} />);

    const stamp = titled(reason)!;
    expect(stamp.textContent).toBe("DLL");
    expect(stamp.className.split(/\s+/)).not.toContain("uppercase");
    expect(stamp.className.split(/\s+/)).toContain("text-[var(--danger)]");
  });

  it("keeps the stamp and the balance on the header while the card is folded", () => {
    const refusal = { kind: "locked" as const, stamp: "Locked", reason: "Locked out until tomorrow." };
    mount(
      <BoardCard
        card={bookCard(statusOf({ refusal }))}
        onMutated={() => {}}
        expanded={false}
        onToggleExpanded={() => {}}
      />,
    );

    expect(rows()).toHaveLength(0);
    expect(stamps()).toContain("Locked");
    expect(headerText()).toContain("$48,722.90");
  });

  // One refusal wording per card: on an account the live-account block refuses,
  // the rows' `No Auto-Trade` chip is it, and the state stamp would be a second.
  it("keeps the balance but wears no state stamp on an account the live-account block refuses", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    try {
      const live: BoardAccount = {
        id: ACCOUNT.id,
        name: "FUNDED-100200-11111111",
        broker: "topstep",
        practice: false,
        autoTrade: { permitted: false, reason: LIVE_ACCOUNT_REFUSAL },
      };
      const refusal = { kind: "dead" as const, stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL };
      const card = build({
        groups: [parent("grp-orb", "orb", "book-1")],
        deployments: [leg("leg-orb", "grp-orb", "orb")],
        accounts: [live],
        groupByBook: true,
        accountStatus: statusOf({ refusal }),
      })[0];
      expect(card.legs[0].autoTradeRefused).toBe(true);
      mount(<BoardCard card={card} onMutated={() => {}} />);

      expect(headerText()).toContain("$48,722.90");
      expect(stamps()).not.toContain("Dead");
      expect(titled(ACCOUNT_DEAD_REFUSAL)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /** The header's two lines: the title line and the meta line under it. */
  const headerLines = () => {
    const [title, meta] = Array.from(container!.querySelectorAll<HTMLElement>("header > div"));
    return { title, meta };
  };

  it("puts the balance and then the stamp on the line under the account name, the budget and controls on the title line", () => {
    const refusal = { kind: "locked" as const, stamp: "Locked", reason: "Locked out until tomorrow." };
    mount(<BoardCard card={bookCard(statusOf({ refusal }))} onMutated={() => {}} />);

    const { title, meta } = headerLines();
    expect(title.textContent).toContain(ACCOUNT.name);
    expect(title.textContent).toContain("Risk/trade:");
    expect(title.textContent).toContain("✕");
    expect(title.textContent).not.toContain("Balance:");
    expect(title.textContent).not.toContain("Locked");

    const balance = titled("Balance as of 17:55 ET")!;
    const stamp = titled("Locked out until tomorrow.")!;
    expect(meta.contains(balance)).toBe(true);
    expect(meta.contains(stamp)).toBe(true);
    // Stamp immediately after the balance, both left of the open count and P&L.
    expect(balance.nextElementSibling).toBe(stamp);
    expect(meta.textContent).toMatch(/^Balance:\$48,722\.90Locked.*0 open/);
  });

  it("titles the balance without the help cursor, in both its figure and its em-dash", () => {
    mount(<BoardCard card={bookCard(statusOf())} onMutated={() => {}} />);
    const figure = titled("Balance as of 17:55 ET")!;
    expect(figure.className).not.toContain("cursor-help");
    expect(figure.querySelector(".cursor-help")).toBeNull();

    act(() => root?.unmount());
    mount(<BoardCard card={bookCard(statusOf({ balanceUsd: null, balanceAt: null }))} onMutated={() => {}} />);
    const dash = titled(BALANCE_NEVER_READ)!;
    expect(dash.textContent).toBe("Balance:—");
    expect(dash.className).not.toContain("cursor-help");
  });

  it("keeps the balance and stamp on the meta line of a folded card", () => {
    const refusal = { kind: "dead" as const, stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL };
    mount(
      <BoardCard card={bookCard(statusOf({ refusal }))} onMutated={() => {}} expanded={false} onToggleExpanded={() => {}} />,
    );

    expect(rows()).toHaveLength(0);
    const { meta } = headerLines();
    expect(meta.textContent).toContain("$48,722.90");
    expect(meta.contains(titled(ACCOUNT_DEAD_REFUSAL)!)).toBe(true);
  });

  it("wears no stamp on an account the gate permits", () => {
    mount(<BoardCard card={bookCard(statusOf())} onMutated={() => {}} />);

    for (const s of Object.values(ACCOUNT_STATE_STAMP)) expect(stamps()).not.toContain(s);
  });
});

describe("BoardCard — a hand-made deployment is unchanged beside it", () => {
  it("keeps GRP on a deployment that fans across accounts", () => {
    mount(<BoardCard card={handMadeCard()} onMutated={() => {}} />);

    expect(stamps()).toContain("GRP");
    expect(stamps()).not.toContain("BOOK");
  });

  it("keeps the budget on each row that names an account, and none on the header", () => {
    mount(<BoardCard card={handMadeCard()} onMutated={() => {}} />);

    expect(headerText()).not.toContain("Risk/trade");
    expect(rows().map((a) => a.textContent ?? "")).toEqual([
      expect.stringContaining("Risk/trade:"),
      expect.stringContaining("Risk/trade:"),
    ]);
    expect(rows().map((a) => a.textContent ?? "")).toEqual([
      expect.stringContaining(ACCOUNT.name),
      expect.stringContaining(OTHER_ACCOUNT.name),
    ]);
  });

  it("keeps ✕, ⏸ and the ✎ live", () => {
    mount(<BoardCard card={handMadeCard()} onMutated={() => {}} />);

    expect(headerControl("✕").disabled).toBe(false);
    expect(headerControl("⏸").disabled).toBe(false);
    expect(headerControl("⏸").getAttribute("title")).toBe("Pause this deployment");
    expect(
      container!.querySelector('header a[aria-label="Edit deployment"]')?.getAttribute("href"),
    ).toBe("/deployments/grp-1/edit");
  });

  it("keeps a leg's own ⏸ live", () => {
    mount(<BoardCard card={handMadeCard()} onMutated={() => {}} />);

    expect(legControl("⏸").disabled).toBe(false);
    expect(legControl("⏸").getAttribute("title")).toBe("Pause this leg");
  });

  it("gives a healthy row no recovery band", () => {
    mount(<BoardCard card={handMadeCard()} onMutated={() => {}} />);

    expect(recoverButton()).toBeNull();
  });
});

// Below `sm` (2026-10-28): the operator reads positions and flattens from a
// 390px phone. jsdom has no layout, so these pin the class pairs and DOM order.
describe("BoardCard — the phone layout", () => {
  /** Three playbooks on one account, Opening Range Breakout holding a position. */
  function mixedBook(): BoardDeployment {
    return build({
      groups: [
        parent("grp-orb", "orb", "book-1"),
        parent("grp-ema", "ema-bounce", "book-1"),
        parent("grp-x", "ema-crossover", "book-1"),
      ],
      deployments: [
        leg("leg-orb", "grp-orb", "orb"),
        leg("leg-ema", "grp-ema", "ema-bounce"),
        leg("leg-x", "grp-x", "ema-crossover"),
      ],
      groupByBook: true,
      sessionPnl: (id) =>
        id === "leg-orb" ? { ...emptyPnl(), unrealized: 37.5, total: 37.5, hasOpenPosition: true } : emptyPnl(),
    })[0];
  }

  const flatLine = () => container!.querySelector<HTMLButtonElement>('[data-board-rows="phone"] button[aria-expanded]');
  const hrefs = (links: HTMLAnchorElement[]) => links.map((a) => a.getAttribute("href"));

  it("keeps ✎ and ✕ inside desktop-only wrappers and the card's ⏸ on every breakpoint", () => {
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    const edit = container!.querySelector("header span[aria-disabled]")!;
    for (const el of [edit, headerControl("✕")]) {
      expect(deskOnlyWrapper(el)?.className.split(/\s+/)).toEqual(["hidden", "sm:contents"]);
    }
    expect(deskOnlyWrapper(headerControl("⏸"))).toBeNull();
    expect(textAt("phone")).not.toMatch(/[✎✕]/);
    expect(textAt("desk")).toContain("✎");
    expect(textAt("desk")).toContain("✕");
  });

  it("gives the account name the title line on a phone by moving the budget to a phone-only third line beside the open count and P&L", () => {
    mount(<BoardCard card={bookCard(statusOf())} onMutated={() => {}} />);

    const [title, meta, third] = Array.from(container!.querySelectorAll<HTMLElement>("header > div"));
    expect(third.className.split(/\s+/)).toContain("sm:hidden");
    expect(third.textContent).toMatch(/^Risk\/trade:\$500.*0 open\$0\.00$/);
    // The desk's copies are the phone-hidden ones.
    const deskRisk = Array.from(title.querySelectorAll("span")).find((s) => s.textContent?.startsWith("Risk/trade"))!;
    expect(deskOnlyWrapper(deskRisk)?.className).toContain("sm:contents");
    const deskMoney = Array.from(meta.querySelectorAll("span")).find((s) => s.textContent === "0 open")!.parentElement!;
    expect(deskMoney.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "sm:inline-flex"]));
    // Each figure reads once per breakpoint, and the phone's second line is the balance.
    for (const bp of ["phone", "desk"] as const) {
      expect(textAt(bp).match(/0 open/g)).toHaveLength(1);
      expect(textAt(bp).match(/Risk\/trade:/g)).toHaveLength(1);
    }
    expect(meta.textContent).toMatch(/^Balance:\$48,722\.90/);
  });

  it("leaves a hand-made card's open count and P&L on its meta line on a phone", () => {
    mount(<BoardCard card={handMadeCard()} onMutated={() => {}} />);

    expect(container!.querySelectorAll("header > div")).toHaveLength(2);
    expect(textAt("phone")).toContain("0 open");
  });

  it("drops the row's ☰ on a phone and keeps its ⏸ and ▼", () => {
    mount(<BoardCard card={mixedBook()} onMutated={() => {}} />);

    const row = phoneRows()[0].parentElement!;
    const log = row.querySelector('a[href^="/logs"]')!;
    expect(deskOnlyWrapper(log)?.className.split(/\s+/)).toEqual(["hidden", "sm:contents"]);
    const glyphs = Array.from(row.querySelectorAll("button")).map((b) => b.textContent);
    expect(glyphs).toEqual(["⏸", "▼"]);
    for (const b of Array.from(row.querySelectorAll("button"))) expect(deskOnlyWrapper(b)).toBeNull();
  });

  it("lets the playbook name wrap on a phone and restores the fixed truncating column from sm", () => {
    mount(<BoardCard card={mixedBook()} onMutated={() => {}} />);

    const name = rows()[0].querySelector<HTMLElement>("span.font-mono.text-xs")!;
    const cls = name.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["flex-1", "min-w-0", "break-words", "sm:w-40", "md:w-72", "sm:truncate"]));
    expect(cls).not.toContain("truncate");
    expect(cls).not.toContain("w-40");
  });

  it("breaks the row onto a second line under the name on a phone only, the chip a size up there", () => {
    mount(<BoardCard card={mixedBook()} onMutated={() => {}} />);

    const row = rows().find((a) => a.getAttribute("href") === "/deployments/leg-orb")!;
    const lineBreak = row.querySelector<HTMLElement>("span.basis-full")!;
    expect(lineBreak.className).toContain("sm:hidden");
    const chip = lineBreak.nextElementSibling as HTMLElement;
    expect(chip.textContent).toBe("In Pos");
    const chipCls = chip.className.split(/\s+/);
    expect(chipCls).toEqual(expect.arrayContaining(["text-xs", "sm:text-[10px]", "sm:min-w-[4.5rem]", "sm:ml-0"]));
    expect(chipCls).not.toContain("text-[10px]");
    expect(chipCls).not.toContain("min-w-[4.5rem]");
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap"]));
  });

  it("splits the desk list and the phone list by class, the desk list keeping the card's order", () => {
    const card = mixedBook();
    mount(<BoardCard card={card} onMutated={() => {}} />);

    const desk = container!.querySelector('[data-board-rows="desk"]')!;
    const phone = container!.querySelector('[data-board-rows="phone"]')!;
    expect(desk.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
    expect(phone.className.split(/\s+/)).toContain("sm:hidden");
    expect(hrefs(rows())).toEqual(card.legs.map((l) => `/deployments/${l.id}`));
  });

  it("leads the phone list with the open row and folds the flat ones behind a count line that opens them in place", () => {
    mount(<BoardCard card={mixedBook()} onMutated={() => {}} />);

    expect(hrefs(phoneRows())).toEqual(["/deployments/leg-orb"]);
    const line = flatLine()!;
    expect(line.textContent).toBe(`2 flat · ${PHONE_FLAT_SHOW}`);
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.querySelector("svg")).not.toBeNull();

    act(() => line.click());
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(line.textContent).toBe(`2 flat · ${PHONE_FLAT_HIDE}`);
    const phone = phoneRows();
    expect(phone[0].getAttribute("href")).toBe("/deployments/leg-orb");
    // Open row, then the line, then the flat rows, in DOM order.
    expect(phone[0].compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const flat of phone.slice(1)) {
      expect(line.compareDocumentPosition(flat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }

    act(() => line.click());
    expect(hrefs(phoneRows())).toEqual(["/deployments/leg-orb"]);
  });

  it("never drops a row: the phone's two groups, opened, are the desk's rows", () => {
    for (const card of [mixedBook(), bookCard(), handMadeCard(), detachedCard()]) {
      mount(<BoardCard card={card} onMutated={() => {}} />);
      act(() => flatLine()?.click());
      const { open, flat } = partitionPhoneRows(card.legs);
      expect(open.length + flat.length).toBe(card.legs.length);
      expect(flatLine()?.textContent ?? "0 flat").toMatch(new RegExp(`^${flat.length} flat`));
      expect([...hrefs(phoneRows())].sort()).toEqual([...hrefs(rows())].sort());
      act(() => root?.unmount());
      container?.remove();
    }
    root = null;
    container = null;
  });

  it("shows only the count line on a phone when nothing on the card is open", () => {
    mount(<BoardCard card={bookCard()} onMutated={() => {}} />);

    expect(phoneRows()).toHaveLength(0);
    expect(flatLine()?.textContent).toBe(`2 flat · ${PHONE_FLAT_SHOW}`);
  });

  it("counts a closing row and a paused row still holding a position as open, in the card's order", () => {
    const legs = mixedBook().legs;
    const pausing = { ...legs[0], status: "Pausing" as const };
    const pausedHolding = {
      ...legs[1],
      status: "Paused" as const,
      chip: { kind: "paused" as const, tone: "muted" as const },
      sessionPnl: { ...emptyPnl(), hasOpenPosition: true },
    };
    const flat = { ...legs[2], sessionPnl: emptyPnl(), chip: { kind: "flat" as const, tone: "muted" as const } };
    const split = partitionPhoneRows([flat, pausing, pausedHolding]);
    expect(split.open.map((l) => l.id)).toEqual([pausing.id, pausedHolding.id]);
    expect(split.flat.map((l) => l.id)).toEqual([flat.id]);
  });

  it("stretches Flatten all across the strip's second row on a phone at the cluster's h-7, and sits right from sm", () => {
    mount(<FlattenAllButton token="test-token" />);

    const cls = container!.querySelector("button")!.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["flex-1", "justify-center", "h-7", "sm:flex-none"]));
    expect(cls.some((c) => /min-h-/.test(c))).toBe(false);

    const board = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "board.tsx"), "utf8");
    expect(board).toMatch(/flex flex-wrap sm:flex-nowrap items-center gap-x-8/);
    expect(board).toMatch(/ml-auto flex items-center gap-2 basis-full sm:basis-auto">\s*<ViewControls/);
  });
});

// A68: an in-position leg the broker read did not match rendered `U: $0.00`,
// because the hook answered `0` for a position it had no mark for.
describe("BoardCard — an open position nothing prices reads as no reading", () => {
  function inPositionCard(answer: PnLBreakdown): BoardDeployment {
    return build({
      groups: [parent("grp-orb", "orb", null)],
      deployments: [leg("leg-orb", "grp-orb", "orb")],
      groupByBook: false,
      sessionPnl: () => answer,
    })[0];
  }

  function legMoney(label: "R" | "U"): HTMLElement {
    const cell = Array.from(rows()[0].querySelectorAll<HTMLElement>("span.inline-flex")).find(
      (s) => s.firstElementChild?.textContent === `${label}:`,
    );
    if (!cell) throw new Error(`no ${label}: cell on the row`);
    return cell.lastElementChild as HTMLElement;
  }

  it("A68 — renders U: as an em-dash with its reason, never $0.00, and keeps R: and the count", () => {
    mount(
      <BoardCard
        card={inPositionCard({ ...emptyPnl(), realized: -12.5, unrealized: null, total: null, hasOpenPosition: true })}
        onMutated={() => {}}
      />,
    );

    const u = legMoney("U");
    expect(u.textContent).toBe("—");
    expect(u.querySelector("[title]")?.getAttribute("title")).toBe(UNREALIZED_UNPRICED);
    expect(legMoney("R").textContent).toBe(formatUsd(-12.5));
    expect(headerText()).toContain("1 open");
    expect(headerText()).not.toContain("$0.00");
    expect(container!.querySelector(`header [title="${TOTAL_UNPRICED}"]`)?.textContent).toBe("—");
  });

  it("renders a priced position's unrealized as the number, as before", () => {
    mount(
      <BoardCard
        card={inPositionCard({ ...emptyPnl(), unrealized: 37.5, total: 37.5, hasOpenPosition: true })}
        onMutated={() => {}}
      />,
    );

    expect(legMoney("U").textContent).toBe(formatUsd(37.5));
    expect(headerText()).toContain(formatUsd(37.5));
    expect(container!.querySelector(`[title="${UNREALIZED_UNPRICED}"]`)).toBeNull();
  });
});

describe("BoardCard — display privacy masks the account and its balance, never P&L", () => {
  beforeEach(() => {
    localStorage.clear();
    catalogue.accounts = [OTHER_ACCOUNT, ACCOUNT];
  });

  function legMoneyText(row: HTMLAnchorElement): string[] {
    return Array.from(row.querySelectorAll<HTMLElement>("span.inline-flex"))
      .filter((s) => /^[RU]:$/.test(s.firstElementChild?.textContent ?? ""))
      .map((s) => s.lastElementChild?.textContent ?? "");
  }

  function hideBoth() {
    localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    localStorage.setItem(HIDE_BALANCES_KEY, "true");
  }

  const pricedBook = () =>
    build({
      groups: [parent("grp-orb", "orb", "book-1"), parent("grp-ema", "ema-bounce", "book-1")],
      deployments: [leg("leg-orb", "grp-orb", "orb"), leg("leg-ema", "grp-ema", "ema-bounce")],
      groupByBook: true,
      accountStatus: statusOf(),
      sessionPnl: () => ({ ...emptyPnl(), realized: 25, unrealized: -12.5, total: 12.5, hasOpenPosition: true }),
    })[0];

  it("reads Account 1 and $xx,xxx.xx on a book card while the rows' R: and U: are unchanged", () => {
    hideBoth();
    mount(
      <PrivacyProvider>
        <BoardCard card={pricedBook()} onMutated={() => {}} />
      </PrivacyProvider>,
    );

    // Numbered by ascending id over the catalogue: 5001 before 5002.
    expect(container!.querySelector("h2")?.textContent).toBe("Account 1");
    expect(headerText()).not.toContain(ACCOUNT.name);
    expect(headerText()).toContain(`Balance:${MASKED_USD}`);
    expect(headerText()).not.toContain("$48,722.90");
    for (const row of rows()) expect(legMoneyText(row)).toEqual([formatUsd(25), formatUsd(-12.5)]);
    expect(headerText()).toContain(formatUsd(25));
  });

  it("shows the account and the balance as before with the switches off", () => {
    mount(
      <PrivacyProvider>
        <BoardCard card={pricedBook()} onMutated={() => {}} />
      </PrivacyProvider>,
    );

    expect(container!.querySelector("h2")?.textContent).toBe(ACCOUNT.name);
    expect(headerText()).toContain("$48,722.90");
  });

  it("names each leg's account by its alias on a hand-made card", () => {
    hideBoth();
    mount(
      <PrivacyProvider>
        <BoardCard card={handMadeCard()} onMutated={() => {}} />
      </PrivacyProvider>,
    );

    const names = rows().map((r) => r.querySelector("span.font-mono.text-xs")?.textContent);
    expect(names).toEqual(["Account 1", "Account 2"]);
    expect(container!.textContent).not.toContain(ACCOUNT.name);
    expect(container!.textContent).not.toContain(OTHER_ACCOUNT.name);
  });
});

describe("BoardCard — a detached row carries the way back off itself", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("states the reason in words, and never as the stored code", () => {
    // `account_unavailable_at_boot` was a variable name in a tooltip, and it
    // was the only thing a detached row ever said about itself (bugs.md A74).
    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);

    expect(container!.textContent).toContain(describeOrphanReason("account_unavailable_at_boot"));
    expect(container!.textContent).toContain(DETACHED_RECOVER_NOTE);
    expect(container!.innerHTML).not.toContain("account_unavailable_at_boot");
  });

  it("renders the recovery as a labelled control, not a fourth glyph in the cluster", () => {
    // The row's `☰ ⏸ ▼` are pressed by shape; an action that re-arms a
    // deployment for live trading may not be one of them.
    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);

    const button = recoverButton();
    expect(button?.textContent).toBe(DETACHED_RECOVER_LABEL);
    expect(button?.className).toContain("btn-emerald");
  });

  it("renders the row's own ▶ inert, naming the control that does clear the markers", () => {
    // A plain resume writes `Active` and clears nothing, so a live glyph here
    // is a second control for the same intent with only one of them working.
    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);

    const toggle = legControl("▶");
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("title")).toBe(DETACHED_RESUME_REFUSAL);
  });

  it("posts clear-orphan for that leg, and only after the activation prompts", async () => {
    // Re-enabling is an activation: it writes `status='Active', enabled=1` on
    // a funded-track account, which is the same weight as a deploy.
    const calls = stubFetch({ ok: true, body: { ok: true } });
    const confirmed = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmed);

    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);
    await press(recoverButton()!);

    expect(confirmed).toHaveBeenCalled();
    expect(calls.filter((c) => c.url.includes("clear-orphan"))).toEqual([
      { url: "/api/deployments/leg-orb/clear-orphan", method: "POST" },
    ]);
  });

  it("does not post at all when the operator declines the prompt", async () => {
    const calls = stubFetch({ ok: true, body: { ok: true } });
    vi.stubGlobal("confirm", () => false);

    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);
    await press(recoverButton()!);

    expect(calls.some((c) => c.url.includes("clear-orphan"))).toBe(false);
  });

  it("renders a refusal verbatim and leaves the row visibly unchanged", async () => {
    // The 403 is the live-account block's own sentence — the same one the API,
    // the engine log and the held-back notice carry — so it is passed through
    // rather than re-worded. And a refused clear must not clear anything: the
    // band, the reason and the inert ▶ are all still there afterwards.
    const refusal = "Auto-trading is not permitted on live accounts per Topstep TOS.";
    stubFetch({ ok: false, status: 403, body: { error: refusal } });
    vi.stubGlobal("confirm", () => true);

    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);
    await press(recoverButton()!);

    expect(container!.textContent).toContain(refusal);
    expect(container!.textContent).toContain(describeOrphanReason("account_unavailable_at_boot"));
    expect(recoverButton()?.disabled).toBe(false);
    expect(legControl("▶").disabled).toBe(true);
  });

  it("offers no working restore while the row still owes a close", async () => {
    // `clearOrphanedAndReEnable` writes `Active, enabled=1` regardless of
    // status, so a live press here retracts the operator's Destroy, drops the
    // row out of `listClosingDeployments()` and re-arms entries over an open
    // position. The route 409s with the same sentence; the control is disabled
    // in front of it rather than left live (bugs.md A74).
    const calls = stubFetch({ ok: true, body: { ok: true } });
    vi.stubGlobal("confirm", () => true);

    mount(<BoardCard card={detachedClosingCard()} onMutated={() => {}} />);
    const button = recoverButton();

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("title")).toBe(RESTORE_WOULD_RETRACT_A_CLOSE);
    // The band stays — the reason is still what the operator came for — and
    // the note that describes a press that would be refused is replaced by the
    // refusal itself.
    expect(container!.textContent).toContain(
      describeOrphanReason("place_order_account_not_found"),
    );
    expect(container!.textContent).toContain(RESTORE_WOULD_RETRACT_A_CLOSE);
    expect(container!.textContent).not.toContain(DETACHED_RECOVER_NOTE);

    await press(button!);
    expect(calls.some((c) => c.url.includes("clear-orphan"))).toBe(false);
  });

  it("offers no working restore on a book's row whose playbook is switched off (bugs.md A85)", async () => {
    // The route 409s here — `clearOrphanedAndReEnable` would leave the parent
    // off and the leg holding its own slot — so the band says the first move
    // instead of offering a press that can only be refused.
    const calls = stubFetch({ ok: true, body: { ok: true } });
    vi.stubGlobal("confirm", () => true);

    mount(<BoardCard card={detachedBookCard(false)} onMutated={() => {}} />);
    const button = recoverButton();

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("title")).toBe(RESTORE_NEEDS_PLAYBOOK_ON);
    expect(container!.textContent).toContain(RESTORE_NEEDS_PLAYBOOK_ON);
    expect(container!.textContent).not.toContain(DETACHED_RECOVER_NOTE);

    await press(button!);
    expect(calls.some((c) => c.url.includes("clear-orphan"))).toBe(false);
  });

  it("keeps the restore live on a book's row whose playbook is on", () => {
    mount(<BoardCard card={detachedBookCard(true)} onMutated={() => {}} />);

    expect(recoverButton()?.disabled).toBe(false);
    expect(container!.textContent).toContain(DETACHED_RECOVER_NOTE);
  });

  it("says a request that never landed changed nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("clear-orphan")) throw new Error("offline");
        return { ok: true, json: async () => ({ available: false }) };
      }),
    );
    vi.stubGlobal("confirm", () => true);

    mount(<BoardCard card={detachedCard()} onMutated={() => {}} />);
    await press(recoverButton()!);

    expect(container!.textContent).toContain("never reached the server");
    expect(container!.textContent).toContain("This deployment is unchanged.");
  });
});
