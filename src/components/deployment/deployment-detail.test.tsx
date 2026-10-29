// @vitest-environment jsdom
/**
 * The drill-in's remount-on-question rule.
 *
 * `DeploymentBody`'s account filter is `useState` seeded from the URL, and a
 * seed does not re-seed. A second `▸` press on a *different leg of the same
 * group* changes the href, resolves to the same card, re-renders the same
 * component instance — and keeps the first leg's selection, so the page
 * answers about the wrong account under the right URL. The fix is one `key`
 * expression, and it is the shape phase 1's branded selector already got
 * caught by: **it compiles, type-checks and passes every test when deleted.**
 * A tidy that drops it has to fail here.
 *
 * The DOM is what makes it observable — the defect is state surviving a
 * render, per [testing/patterns.md](../../docs/modules/testing/patterns.md).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BROKEN_ROW_EDIT_REASON,
  buildBoard,
  type BoardAccount,
  type BoardDeployment,
  type BoardInput,
} from "@/components/board/board-model";
import { describeOrphanReason, DETACHED_RECOVER_LABEL } from "@/components/board/board-view";
import { RESTORE_WOULD_RETRACT_A_CLOSE, type Deployment, type DeploymentGroup } from "@/lib/trading/domain";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import type { StrategyTrade } from "@/lib/db/trade-types";
import { HIDE_ACCOUNT_IDS_KEY } from "@/components/privacy/privacy-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page's data sources are hooks over a session, a store and a poll; none
// of them is what this file is about. `board` is mutable so a test can change
// what the URL resolves to between renders.
// `accounts` is the catalogue the privacy provider numbers and `trades` what
// the table lists; only the display-privacy cases set them.
const state = vi.hoisted(() => ({
  board: [] as unknown[],
  accounts: [] as Array<{ id: number; name: string }>,
  trades: [] as unknown[],
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/components/board/use-board", () => ({
  useBoardModel: () => ({
    board: state.board,
    refreshGroups: async () => {},
    deploymentsLoadState: "ready" as const,
    livePnl: {},
  }),
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({
    status: "connected" as const,
    positions: [],
    unrealizedForPosition: () => null,
    token: "test-token",
    practiceOnly: false,
    accounts: state.accounts,
  }),
  TradingContext: { Provider: null },
}));

vi.mock("@/lib/hooks/use-strategies", () => ({
  useDeployments: () => ({ deployments: [] }),
  loadDeployments: () => [],
  refreshDeployments: vi.fn(async () => {}),
  syncEngine: vi.fn(async () => {}),
}));

vi.mock("@/lib/hooks/use-trades", () => ({
  useTrades: () => ({
    trades: state.trades,
    summary: null,
    slippage: null,
    dailyPnlGate: null,
    loading: true,
    refresh: async () => {},
  }),
}));

// `trade-chart.tsx` pulls lightweight-charts, which wants a canvas. Nothing
// here expands a row.
vi.mock("@/components/chart/trade-chart", () => ({ TradeChart: () => null }));

const { DeploymentDetail } = await import("./deployment-detail");
const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");

// ── Fixtures ────────────────────────────────────────────────────────────

// Real Topstep practice names, per the prefix table in
// docs/modules/brokers/topstep.md.
const ACCOUNT_A: BoardAccount = {
  id: 5001,
  name: "PRAC-V2-100200-90012114",
  broker: "topstep",
  practice: true,
  autoTrade: { permitted: true },
};
const ACCOUNT_B: BoardAccount = {
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

function deployment(overrides: Partial<Deployment>): Deployment {
  return {
    id: "dep-a",
    strategyKey: "ema-crossover",
    accountId: ACCOUNT_A.id,
    ticker: "/MNQ",
    contractId: null,
    status: "Active",
    paramValues: { size: 1, stopLossOverrideTicks: 20, riskRewardRatio: 2 },
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T12:00:00.000Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: "grp-1",
    enabledSnapshot: null,
    ...overrides,
  };
}

const GROUP: DeploymentGroup = {
  id: "grp-1",
  name: null,
  strategyKey: "ema-crossover",
  paramValues: { size: 1, stopLossOverrideTicks: 20, riskRewardRatio: 2 },
  ticker: "/MNQ",
  contractId: null,
  enabled: true,
  bookId: null,
  createdAt: "2026-09-03T12:00:00.000Z",
  updatedAt: "2026-09-03T12:00:00.000Z",
  deletedAt: null,
};

/** One deployment, two legs — the shape the bug needs. */
function twoLegCard(): BoardDeployment[] {
  return buildBoard({
    deployments: [
      deployment({ id: "dep-a", accountId: ACCOUNT_A.id }),
      deployment({ id: "dep-b", accountId: ACCOUNT_B.id }),
    ],
    groups: [GROUP],
    accounts: [ACCOUNT_A, ACCOUNT_B],
    trades: [],
    strategy: (key) =>
      key === "ema-crossover"
        ? {
            name: "EMA Crossover",
            timeframe: "5m",
            session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
          }
        : null,
    sessionPnl: selector(() => emptyPnl()),
    regime: () => null,
    // The drill-in renders no risk cell — the board's leg row does. The field
    // still has to be supplied, and `pending` is the arm that asserts nothing.
    risk: () => ({ kind: "pending" }) as const,
  });
}

// ── Harness ─────────────────────────────────────────────────────────────

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state.board = [];
  state.accounts = [];
  state.trades = [];
  localStorage.clear();
});

function mount(ui: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

function rerender(ui: ReactElement) {
  act(() => root!.render(ui));
}

/** The strip's own right-hand label: whose numbers these are. Found through
 *  the `aria-label` the section already carries. */
function scopeLabel(): string {
  const strip = container!.querySelector('section[aria-label="All-time totals"]');
  if (!strip) throw new Error("missing all-time totals strip");
  return strip.lastElementChild?.textContent?.trim() ?? "";
}

/** The scope picker's checked account, read off the row the native radio sits
 *  in — the Account cell is the one after the radio's own cell. */
function checkedAccount(): string {
  const input = container!.querySelector('input[type="radio"]:checked');
  if (!input) throw new Error("no checked account row");
  const row = input.closest("tr");
  return row?.children[1]?.textContent?.trim() ?? "";
}

function accountRows(): HTMLElement[] {
  return Array.from(container!.querySelectorAll<HTMLInputElement>('input[type="radio"]')).flatMap(
    (input) => {
      const row = input.closest("tr");
      return row ? [row as HTMLElement] : [];
    },
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("DeploymentDetail — the scope follows the URL", () => {
  it("re-seeds the account filter when a second leg of the same card is named", () => {
    state.board = twoLegCard();

    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);
    expect(scopeLabel()).toBe(ACCOUNT_A.name);
    expect(checkedAccount()).toBe(ACCOUNT_A.name);

    // Same card, same component position, different leg. Without the `key`
    // the instance survives and keeps leg A's selection.
    rerender(<DeploymentDetail id="dep-b" initialAccountId={null} />);
    expect(scopeLabel()).toBe(ACCOUNT_B.name);
    expect(checkedAccount()).toBe(ACCOUNT_B.name);
  });

  it("re-seeds when only `?account=` changes", () => {
    state.board = twoLegCard();

    mount(<DeploymentDetail id="grp-1" initialAccountId={ACCOUNT_A.id} />);
    expect(scopeLabel()).toBe(ACCOUNT_A.name);

    rerender(<DeploymentDetail id="grp-1" initialAccountId={ACCOUNT_B.id} />);
    expect(scopeLabel()).toBe(ACCOUNT_B.name);
  });

  it("keeps a filter the operator picked when the question has not changed", () => {
    state.board = twoLegCard();
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);

    // The picker is the filter: the "All accounts" row is first.
    act(() => {
      accountRows()[0].click();
    });
    expect(scopeLabel()).toBe("All accounts");

    // A re-render for any other reason — a poll, a store refresh — must not
    // put the URL's account back.
    rerender(<DeploymentDetail id="dep-a" initialAccountId={null} />);
    expect(scopeLabel()).toBe("All accounts");
  });
});

describe("DeploymentDetail — Edit on a card whose parent row is gone", () => {
  /** One leg, no parent: the only shape that produces a `deployment`
   *  target, and the only one where `editHref` is null. */
  function orphanLegCard(): BoardDeployment[] {
    return buildBoard({
      deployments: [deployment({ id: "dep-a", groupId: "grp-gone" })],
      groups: [],
      accounts: [ACCOUNT_A],
      trades: [],
      strategy: (key) =>
        key === "ema-crossover"
          ? {
              name: "EMA Crossover",
              timeframe: "5m",
              session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
            }
          : null,
      sessionPnl: selector(() => emptyPnl()),
      regime: () => null,
    // The drill-in renders no risk cell — the board's leg row does. The field
    // still has to be supplied, and `pending` is the arm that asserts nothing.
    risk: () => ({ kind: "pending" }) as const,
    });
  }

  function editControl(): HTMLElement {
    const el = Array.from(container!.querySelectorAll("a, span")).find(
      (n) => n.textContent?.trim() === "Edit",
    );
    if (!el) throw new Error("no Edit control");
    return el as HTMLElement;
  }

  it("renders inert with the reason instead of a link that goes nowhere", () => {
    // The link resolved up to a parent that by definition does not exist and
    // returned silently — no navigation, no message.
    state.board = orphanLegCard();
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);

    const control = editControl();
    expect(control.tagName).toBe("SPAN");
    expect(control.getAttribute("title")).toBe(BROKEN_ROW_EDIT_REASON);
  });

  it("still links when the parent is there", () => {
    state.board = twoLegCard();
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);

    const control = editControl();
    expect(control.tagName).toBe("A");
    // The editor's own route — this page's sibling, which is why the
    // assertion is the whole href rather than a query fragment.
    expect(control.getAttribute("href")).toBe("/deployments/grp-1/edit");
  });
});

describe("DeploymentDetail — A74: a detached leg carries its reason in words and the way back", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function detachedCard(status: Deployment["status"] = "Paused"): BoardDeployment[] {
    return buildBoard({
      deployments: [
        deployment({
          id: "dep-a",
          status,
          orphanReason: "account_unavailable_at_boot",
          orphanedAt: "2026-09-17T05:21:10.122Z",
        }),
      ],
      groups: [GROUP],
      accounts: [ACCOUNT_A],
      trades: [],
      strategy: () => ({
        name: "EMA Crossover",
        timeframe: "5m",
        session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
      }),
      sessionPnl: selector(() => emptyPnl()),
      regime: () => null,
      risk: () => ({ kind: "pending" }) as const,
    });
  }

  function restoreButton(): HTMLButtonElement | null {
    return (
      Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === DETACHED_RECOVER_LABEL,
      ) ?? null
    );
  }

  it("never renders the stored reason code, and says it in words", () => {
    state.board = detachedCard();
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);

    expect(container!.innerHTML).not.toContain("account_unavailable_at_boot");
    expect(container!.textContent).toContain(describeOrphanReason("account_unavailable_at_boot"));
  });

  it("offers Restore and arm, which posts clear-orphan after the activation prompts", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ available: false, ok: true }) };
      }),
    );
    const confirmed = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmed);

    state.board = detachedCard();
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);
    const button = restoreButton();
    expect(button?.disabled).toBe(false);

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});

    expect(confirmed).toHaveBeenCalled();
    expect(calls).toContain("/api/deployments/dep-a/clear-orphan");
  });

  it("refuses Restore and arm over a leg still closing, with the route's sentence, and posts nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    state.board = detachedCard("Destroying");
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);
    const button = restoreButton();

    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe(RESTORE_WOULD_RETRACT_A_CLOSE);
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("clear-orphan"),
      expect.anything(),
    );
  });

  it("gives a healthy deployment no recovery band", () => {
    state.board = twoLegCard();
    mount(<DeploymentDetail id="dep-a" initialAccountId={null} />);
    expect(restoreButton()).toBeNull();
  });
});

describe("DeploymentDetail — display privacy", () => {
  /** A deployment the operator named after one of its accounts. */
  function namedCard(): BoardDeployment[] {
    return buildBoard({
      deployments: [
        deployment({ id: "dep-a", accountId: ACCOUNT_A.id }),
        deployment({ id: "dep-b", accountId: ACCOUNT_B.id }),
      ],
      groups: [{ ...GROUP, name: `ORB on ${ACCOUNT_A.name}` }],
      accounts: [ACCOUNT_A, ACCOUNT_B],
      trades: [],
      strategy: () => null,
      sessionPnl: selector(() => emptyPnl()),
      regime: () => null,
      risk: () => ({ kind: "pending" }) as const,
    });
  }

  /** One closed trade on leg B, so the table's account column renders. */
  function closedTradeOnB(): StrategyTrade {
    return {
      id: 1,
      deploymentId: "dep-b",
      strategyKey: "ema-crossover",
      accountId: ACCOUNT_B.id,
      ticker: "/MNQ",
      contractId: "CON.F.US.MNQ.Z26",
      side: 0,
      size: 1,
      entryOrderId: 1,
      entryPrice: 21345.25,
      entryFilledAt: "2026-10-23T14:00:00.000Z",
      entrySubmittedAt: "2026-10-23T14:00:00.000Z",
      signalBarTs: null,
      regimeLabel: null,
      regimeClassifierVersion: null,
      sessionKey: null,
      tpOrderId: null,
      slOrderId: null,
      breakEvenMoved: false,
      slMovedToBreakeven: false,
      slTrailEngaged: false,
      exitOrderId: 2,
      exitPrice: 21350.25,
      exitFilledAt: "2026-10-23T14:30:00.000Z",
      exitSubmittedAt: "2026-10-23T14:30:00.000Z",
      exitReason: "Take Profit",
      exitReasonCode: "tp",
      pnlTicks: 20,
      pnlDollars: 10,
      feesDollars: 0.74,
      tickSize: 0.25,
      tickValue: 0.5,
      status: "closed",
      createdAt: "2026-10-23T14:00:00.000Z",
      updatedAt: "2026-10-23T14:30:00.000Z",
      desiredEntryPrice: null,
      entrySlippageTicks: null,
      entrySlippageDollars: null,
      desiredTpPrice: null,
      tpSlippageTicks: null,
      tpSlippageDollars: null,
      desiredSlPrice: null,
      slSlippageTicks: null,
      slSlippageDollars: null,
      desiredTpTicks: null,
      desiredSlTicks: null,
      exitApproximated: false,
      exitResolutionSource: "rest",
      exitDetectedAt: null,
      paramSnapshot: null,
      filterSnapshot: null,
      replayResultJson: null,
      engineSessionId: null,
      deploymentVersionId: null,
    };
  }

  function showAll(hideIds: boolean) {
    if (hideIds) localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    state.accounts = [ACCOUNT_B, ACCOUNT_A];
    state.board = namedCard();
    state.trades = [closedTradeOnB()];
    mount(
      <PrivacyProvider>
        <DeploymentDetail id="grp-1" initialAccountId={null} />
      </PrivacyProvider>,
    );
  }

  /** The trade table's account cell: the row's `title` names the account. */
  const tradeAccountCell = () =>
    Array.from(container!.querySelectorAll<HTMLTableCellElement>("tr[aria-expanded] td[title]"))[0];

  it("reads the alias in the h1, the leg picker and a trade-table account cell while IDs are hidden", () => {
    showAll(true);
    expect(container!.querySelector("h1")?.textContent).toBe("ORB on Account 1");
    expect(accountRows().map((r) => r.children[1]?.textContent?.trim())).toEqual([
      "All accounts",
      "Account 1",
      "Account 2",
    ]);
    expect(tradeAccountCell()?.textContent).toBe("Account 2");
    expect(container!.textContent).not.toContain(ACCOUNT_A.name);
    expect(container!.textContent).not.toContain(ACCOUNT_B.name);
  });

  it("reads the accounts' names with the switch off", () => {
    showAll(false);
    expect(container!.querySelector("h1")?.textContent).toBe(`ORB on ${ACCOUNT_A.name}`);
    expect(tradeAccountCell()?.textContent).toBe(ACCOUNT_B.name);
  });
});
