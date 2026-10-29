// @vitest-environment jsdom
/**
 * What the editor's Save actually sends, and the one render that can destroy
 * a deployment before anyone clicks anything.
 *
 * `deployment-editor-model.test.ts` covers the plan as arithmetic. Neither
 * of the things below is reachable from there:
 *
 * **The seed race.** The group row and the legs hydrate from two independent
 * reads, so the group can arrive a tick before its legs. Seeding then builds
 * an empty account set — and an empty account set is not "no legs selected",
 * it is *every leg unchecked*, so the first paint offers a Save that removes
 * the deployment down to nothing. The last-leg pin does not catch it: that
 * pin refuses the **click** that unchecks a final row, and nothing was
 * clicked. It lives in the gap between two hooks, which is the definition of
 * something only a mount can observe.
 *
 * **The request bodies.** `PATCH /api/groups/[id]` rejects the whole request
 * if `ticker` or `strategyKey` is merely *present*, so a form that helpfully
 * round-tripped them unchanged would fail every save while rendering
 * correctly and passing every model test.
 *
 * Fetch is stubbed as a **recorder**, not a return value — the answer here is
 * the request, not the render that follows it.
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { HIDE_ACCOUNT_IDS_KEY } from "@/components/privacy/privacy-model";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AccountRow } from "@/lib/hooks/use-trading/account-row";
import { LIVE_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import {
  ACCOUNT_DEAD_REFUSAL,
  ACCOUNT_STATE_STAMP,
} from "@/lib/trading/broker-access/account-state-gate";
import type { Deployment, DeploymentGroup, TickerSymbol } from "@/lib/trading/domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  pushed: [] as string[],
  groups: [] as DeploymentGroup[],
  legs: [] as Deployment[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => state.pushed.push(href), replace: () => {} }),
}));

vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

/** The two independent reads, so a test can land them in either order — the
 *  whole point of the seed case. */
vi.mock("@/components/board/use-board", () => ({
  useBoardModel: () => ({
    board: [],
    groups: state.groups,
    refreshGroups: async () => {},
    deploymentsLoadState: "ready" as const,
    livePnl: {},
  }),
}));

vi.mock("@/lib/hooks/use-strategies", () => ({
  useDeployments: () => ({ deployments: state.legs }),
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ token: "test-token", accounts: ACCOUNTS, reloadAccounts: async () => {} }),
}));

// Enumerated, not spread: `trading/strategies` reaches the `require.context`
// strategy loader, which has no vitest equivalent (patterns.md).
vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: () => ({
    config: { name: "EMA Crossover", timeframe: "5m" },
    params: { size: { type: "integer", label: "Size", default: 1, group: "Parameters" } },
  }),
}));

// The form is a separate component with its own tests; this file is about
// what leaves the page. A stub keeps a param-schema change from failing here.
vi.mock("@/components/param-form", () => ({ ParamForm: () => null }));

const { DeploymentEditor } = await import("./deployment-editor");
const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");

// ── Fixtures ────────────────────────────────────────────────────────────

const TICKER = "/MNQ" as TickerSymbol;
const GROUP_ID = "grp-1";

/**
 * Real Topstep names, quoted from the confirmed set in the prefix table at
 * docs/modules/brokers/topstep.md — invented ones probe shape but cannot
 * catch a predicate that matches nothing the outside world issues.
 *
 * **The mix is the point, and getting it wrong is what this fixture caught.**
 * A first draft used `50KTC-` as the refused account; the table says a
 * Trading Combine is **permitted**, and it is the row the punchlist calls out
 * as the one prod verification most likely to be got backwards. So: two
 * practice accounts, one Combine that must be *addable*, and one genuinely
 * funded name — no `PRAC-`, no `<size>KTC-`, no `EXPRESS-` — which is the
 * only shape `classifyAccount` answers LIVE for.
 *
 * `practice` is a real column, not the name: `isPracticeAccount` reads the
 * boolean stamped at the translator boundary, so a `PRAC-`-named row without
 * it classifies LIVE.
 *
 * Each row carries the verdict the server reports on prod (bugs.md A38): the
 * picker reads that field and recomputes nothing.
 */
const PERMITTED = { permitted: true } as const;
const ACCOUNTS: AccountRow[] = [
  { id: 1, name: "PRAC-V2-100200-90012114", broker: "topstep", practice: true, autoTrade: PERMITTED },
  { id: 2, name: "PRAC-V2-100200-90020038", broker: "topstep", practice: true, autoTrade: PERMITTED },
  { id: 3, name: "50KTC-V2-100200-90020038", broker: "topstep", practice: false, autoTrade: PERMITTED },
  {
    id: 4,
    name: "TOPSTEP-FUNDED-100200-90210",
    broker: "topstep",
    practice: false,
    autoTrade: { permitted: false, reason: LIVE_ACCOUNT_REFUSAL },
  },
] as AccountRow[];

function group(): DeploymentGroup {
  return {
    id: GROUP_ID,
    name: "Morning fade",
    strategyKey: "ema-crossover",
    paramValues: { size: 2 },
    ticker: TICKER,
    contractId: null,
    enabled: true,
    bookId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  } as DeploymentGroup;
}

function leg(id: string, accountId: number): Deployment {
  return {
    id,
    groupId: GROUP_ID,
    accountId,
    strategyKey: "ema-crossover",
    ticker: TICKER,
    status: "Active",
    deletedAt: null,
  } as Deployment;
}

// ── Harness ─────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const requests: { url: string; method: string; body: unknown }[] = [];
/** `GET /api/books`' account-state gates, as the next read answers them. */
let booksGates: AccountGateWire[] = [];

/** Answers every call 200 unless `fail` matches the url, so a test can put
 *  one route into its refusal without scripting the rest. */
function stubFetch(fail?: { url: RegExp; status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      requests.push({
        url: input,
        method: init?.method ?? "GET",
        body: init?.body != null ? JSON.parse(init.body) : null,
      });
      if (fail && fail.url.test(input)) {
        return { ok: false, status: fail.status, json: async () => fail.body } as unknown as Response;
      }
      if (input === "/api/books") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ books: [], accounts: booksGates }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }),
  );
}

/** Not a mutation: the account-status check every account picker runs on open. */
const isStatusCheck = (r: { url: string }) => r.url === "/api/accounts/status";

async function mount(el: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(el);
  });
  await act(async () => {});
}

const textOf = () => container?.textContent ?? "";

function buttonSaying(label: string): HTMLButtonElement | null {
  const buttons = Array.from(container?.querySelectorAll("button") ?? []);
  return (buttons.find((b) => b.textContent?.trim() === label) as HTMLButtonElement) ?? null;
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(container?.querySelectorAll('input[type="checkbox"]') ?? []);
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const nameInput = () => container!.querySelector<HTMLInputElement>("#deployment-name")!;
const saveButton = () => buttonSaying("Save");
const groupPatch = () => requests.find((r) => r.url === `/api/groups/${GROUP_ID}` && r.method === "PATCH");

beforeEach(() => {
  // The Combine account in the fixture is addable on prod and refused on
  // staging, where the rule narrows to practice accounts only. This file
  // is about what leaves the page, so it runs on the environment where
  // the account mix is the interesting one.
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  requests.length = 0;
  state.pushed.length = 0;
  state.groups = [group()];
  state.legs = [leg("leg-a", 1), leg("leg-b", 2)];
  booksGates = [];
  stubFetch();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DeploymentEditor — the seed race", () => {
  it("waits for the legs rather than seeding an empty account set", async () => {
    // The group has landed; the deployment store has not. Seeding here is
    // what offered a Save that removed every leg.
    state.legs = [];
    await mount(<DeploymentEditor id={GROUP_ID} />);

    expect(textOf()).toContain("…");
    expect(textOf()).not.toContain("No deployment with this id");
    expect(saveButton()).toBeNull();
  });

  it("says the deployment is gone only when both reads have landed empty", async () => {
    state.groups = [];
    state.legs = [];
    await mount(<DeploymentEditor id={GROUP_ID} />);
    // Group read landed (list is present, id is absent) — but the store has
    // not, so this is still `…` rather than a claim.
    expect(textOf()).toContain("…");

    state.groups = [{ ...group(), id: "someone-else" }];
    await act(async () => root!.render(<DeploymentEditor id={GROUP_ID} />));
    await act(async () => {});
    expect(textOf()).toContain("No deployment with this id");
  });

  it("offers no Save on a freshly seeded, untouched draft", async () => {
    // The other half of the same defect: a seeded draft that reports dirty
    // would fire the same destructive plan on the first click.
    await mount(<DeploymentEditor id={GROUP_ID} />);
    expect(saveButton()?.disabled).toBe(true);
  });
});

describe("DeploymentEditor — what Save sends", () => {
  it("patches only name and paramValues, never ticker or strategyKey", async () => {
    // The route 400s on their mere presence. A key census, not a value check.
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await typeInto(nameInput(), "Renamed");
    await click(saveButton()!);

    const patch = groupPatch();
    expect(patch).toBeDefined();
    expect(Object.keys(patch!.body as object).sort()).toEqual(["name", "paramValues"]);
    expect((patch!.body as { name: string }).name).toBe("Renamed");
  });

  it("sends nothing structural when only the name changed", async () => {
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await typeInto(nameInput(), "Renamed");
    await click(saveButton()!);

    expect(requests.filter((r) => r.url.includes("add-legs"))).toHaveLength(0);
    expect(requests.filter((r) => r.url.includes("remove-leg"))).toHaveLength(0);
    expect(requests.filter((r) => r.url.startsWith("/api/deployments/"))).toHaveLength(0);
  });

  it("adds a checked account through add-legs, and sends nothing else", async () => {
    // The body is an account list and nothing more — a new leg carries no
    // size, since sizing is the account's risk posture. Account 3 is a
    // Trading Combine — permitted.
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await click(checkboxes()[2]);
    await click(saveButton()!);

    const adds = requests.filter((r) => r.url.includes("add-legs"));
    expect(adds).toHaveLength(1);
    expect(adds[0].body).toEqual({ accountIds: [3] });
  });

  it("refuses a funded account and permits a Trading Combine", async () => {
    // The distinction the punchlist flags as most likely to be got backwards:
    // `<size>KTC-` is an evaluation account and deploys; only a name with
    // none of the three prefixes is live.
    await mount(<DeploymentEditor id={GROUP_ID} />);
    const boxes = checkboxes();
    expect(boxes).toHaveLength(4);
    expect(boxes[2].disabled).toBe(false);
    expect(boxes[3].disabled).toBe(true);
    expect(textOf()).toContain("no auto-trade");
  });

  it("keeps a refused account removable once it is already a leg", async () => {
    // The `&& !checked` carve-out. A block that also disabled a checked row
    // would make a pre-block leg on a funded account impossible to unwind
    // through the UI — the refusal becoming the hazard on the wind-down path.
    state.legs = [leg("leg-a", 1), leg("leg-live", 4)];
    await mount(<DeploymentEditor id={GROUP_ID} />);
    const live = checkboxes()[3];
    expect(live.checked).toBe(true);
    expect(live.disabled).toBe(false);

    await click(live);
    await click(saveButton()!);
    expect(requests.some((r) => r.url.endsWith("/remove-leg/leg-live"))).toBe(true);
  });

  it("checks the accounts on open and greys one the account-state gate refuses", async () => {
    // The Combine passes the live-account block on prod; the gate is what
    // refuses it, read off the books answer after the status check settles.
    booksGates = [
      {
        accountId: 3,
        name: ACCOUNTS[2].name,
        refusal: { kind: "dead", stamp: ACCOUNT_STATE_STAMP.dead, reason: ACCOUNT_DEAD_REFUSAL },
        warning: null,
        replacements: [],
      },
    ];
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await act(async () => {});

    const check = requests.findIndex(isStatusCheck);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(requests[check].method).toBe("POST");
    expect(requests.slice(check + 1).some((r) => r.url === "/api/books")).toBe(true);
    const combine = checkboxes()[2];
    expect(combine.disabled).toBe(true);
    expect(combine.closest("label")?.title).toBe(ACCOUNT_DEAD_REFUSAL);
    expect(combine.closest("label")?.textContent).toContain(ACCOUNT_STATE_STAMP.dead);
  });

  it("removes an unchecked leg by leg id, and patches nothing for it", async () => {
    await mount(<DeploymentEditor id={GROUP_ID} />);
    // Uncheck the second leg. Two legs, so the last-leg pin does not fire.
    await click(checkboxes()[1]);
    await click(saveButton()!);

    const removes = requests.filter((r) => r.url.includes("remove-leg"));
    expect(removes).toHaveLength(1);
    expect(removes[0].url).toBe(`/api/groups/${GROUP_ID}/remove-leg/leg-b`);
    expect(requests.filter((r) => r.url === "/api/deployments/leg-b")).toHaveLength(0);
  });

  it("A87 — removes an account with a method the remove-leg route exports", async () => {
    // The mocked fetch answers any method, which is how `DELETE` against a
    // POST-only route passed here for weeks: the assertion is against the
    // route file itself, so the two cannot drift again.
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await click(checkboxes()[1]);
    await click(saveButton()!);

    const [remove] = requests.filter((r) => r.url.includes("remove-leg"));
    const route = readFileSync(
      join(process.cwd(), "src/app/api/groups/[id]/remove-leg/[legId]/route.ts"),
      "utf8",
    );
    expect(route).toMatch(new RegExp(`export async function ${remove.method}\\(`));
  });

  it("patches the parent before it touches any leg", async () => {
    // A 409 on the parent has to leave the legs untouched, so the retry is
    // the same plan rather than a half-applied one.
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await click(checkboxes()[1]);
    await click(saveButton()!);

    const mutating = requests.filter((r) => r.method !== "GET" && !isStatusCheck(r));
    expect(mutating[0].url).toBe(`/api/groups/${GROUP_ID}`);
  });

  it("navigates to the drill-in on success", async () => {
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await typeInto(nameInput(), "Renamed");
    await click(saveButton()!);
    expect(state.pushed).toEqual([`/deployments/${GROUP_ID}`]);
  });
});

describe("DeploymentEditor — the partialConflict 409", () => {
  const conflictBody = {
    partialConflict: true,
    error: "Conflict on 1 of 2 accounts.",
    perLeg: [
      { legId: "leg-a", accountId: 1, conflict: { id: "other", name: "Scalper", strategyKey: "orb" } },
      { legId: "leg-b", accountId: 2, conflict: null },
    ],
  };

  it("renders the blocked accounts and stops before touching a leg", async () => {
    stubFetch({ url: /\/api\/groups\/grp-1$/, status: 409, body: conflictBody });
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await click(checkboxes()[1]);
    await click(saveButton()!);

    expect(textOf()).toContain("1 of 2 account");
    expect(textOf()).toContain("PRAC-V2-100200-90012114");
    expect(textOf()).toContain("Scalper");
    // The structural half must not have run — that is what makes the retry
    // the same plan.
    expect(requests.filter((r) => r.url.includes("remove-leg"))).toHaveLength(0);
  });

  it("names a blocked account by its alias, as the picker does, while IDs are hidden", async () => {
    localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    onTestFinished(() => localStorage.clear());
    stubFetch({ url: /\/api\/groups\/grp-1$/, status: 409, body: conflictBody });
    await mount(
      <PrivacyProvider>
        <DeploymentEditor id={GROUP_ID} />
      </PrivacyProvider>,
    );
    await click(checkboxes()[1]);
    await click(saveButton()!);

    const blocked = container!.querySelector("li span.font-mono");
    expect(blocked?.textContent).toBe("Account 1");
    expect(textOf()).not.toContain("PRAC-V2-100200-90012114");
  });

  it("resends the same plan with applyToOverrides on confirm", async () => {
    stubFetch({ url: /\/api\/groups\/grp-1$/, status: 409, body: conflictBody });
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await typeInto(nameInput(), "Renamed");
    await click(saveButton()!);

    const first = groupPatch()!;
    expect((first.body as { applyToOverrides?: boolean }).applyToOverrides).toBeUndefined();

    await click(buttonSaying("Apply anyway")!);
    const patches = requests.filter((r) => r.url === `/api/groups/${GROUP_ID}` && r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect((patches[1].body as { applyToOverrides?: boolean }).applyToOverrides).toBe(true);
    expect((patches[1].body as { name: string }).name).toBe("Renamed");
  });

  it("falls through to the error line on a 409 that is not a partial conflict", async () => {
    // An empty conflict panel would claim nothing is wrong on a failed save.
    stubFetch({ url: /\/api\/groups\/grp-1$/, status: 409, body: { error: "Update failed" } });
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await typeInto(nameInput(), "Renamed");
    await click(saveButton()!);

    expect(textOf()).toContain("Update failed");
    expect(buttonSaying("Apply anyway")).toBeNull();
  });

  it("surfaces a leg-removal refusal verbatim, because it names the position", async () => {
    stubFetch({
      url: /remove-leg/,
      status: 409,
      body: { error: "Leg has an open position on MNQU6 — close it first." },
    });
    await mount(<DeploymentEditor id={GROUP_ID} />);
    await click(checkboxes()[1]);
    await click(saveButton()!);

    expect(textOf()).toContain("open position on MNQU6");
  });
});

/**
 * The config file Export wrote had no reader once Import went, so the button
 * went with it (2026-10-07). Settings travel to a CLI run through the Playbook
 * page's *Try settings* instead.
 */
describe("DeploymentEditor — no Export", () => {
  const exportControls = () =>
    Array.from(container?.querySelectorAll("button, a") ?? []).filter((el) =>
      /export/i.test(`${el.textContent ?? ""} ${el.getAttribute("title") ?? ""}`),
    );

  it("renders no Export control on a clean draft or a dirty one", async () => {
    await mount(<DeploymentEditor id={GROUP_ID} />);
    // The header still rendered — otherwise an empty census proves nothing.
    expect(saveButton()).not.toBeNull();
    expect(exportControls()).toHaveLength(0);

    await typeInto(nameInput(), "Renamed");
    expect(saveButton()!.disabled).toBe(false);
    expect(exportControls()).toHaveLength(0);
  });
});
