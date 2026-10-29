// @vitest-environment jsdom
/**
 * *A row the platform will not trade is visibly refused and takes no budget.*
 *
 * **The DOM is what makes it observable.** The verdict is a boolean fed into a
 * `disabled` prop and a stamp; asserting the boolean would pass with either
 * unwired, which is exactly the failure this file exists to catch — the block
 * shipped rendering every catalogued account identically, so an operator could
 * type a budget into an account the engine then withheld every deployment on.
 *
 * Nothing here reimplements the rule. The verdict is the server's, so every
 * fixture row carries the `autoTrade` `/api/accounts/risk` would answer for it,
 * and the refusals are the policy module's constants, so a reworded refusal
 * moves the assertion with it rather than failing it.
 */
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  AccountRiskBlock,
  CLOSED_AT_BROKER_STAMP,
  FROM_TOPSTEP_BADGE,
  LOCKED_AT_BROKER_STAMP,
  START_BALANCE_HIDDEN_TITLE,
  lockoutLine,
  topstepDailyLossLine,
  type AccountStatusCheckState,
} from "./account-risk-block";
import {
  LIVE_ACCOUNT_REFUSAL,
  STAGING_PRACTICE_ONLY_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
  autoTradeVerdict,
  type AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";
import {
  NON_TOPSTEP_PHASE_REFUSAL,
  ACCOUNT_RISK_PHASE_LABELS,
  accountAtFloorRefusal,
  COMBINE_MLL_REFUSAL,
  PAYOUT_PHASE_PATH_REFUSAL,
  POST_PAYOUT_PHASE_REFUSAL,
  phaseRuleParameterRefusal,
  type AccountRiskPhase,
} from "@/lib/trading/orders/account-phase-sizer";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import {
  HIDE_ACCOUNT_IDS_KEY,
  HIDE_BALANCES_KEY,
  MASKED_USD,
  maskUsdFigures,
} from "@/components/privacy/privacy-model";

// Spied, not replaced: the block must never ask the predicate, so a call
// here is the regression the A38 case below fails on.
vi.mock("@/lib/trading/broker-access/account-trading-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trading/broker-access/account-trading-policy")>();
  return { ...actual, autoTradeVerdict: vi.fn(actual.autoTradeVerdict) };
});

// The catalogue the privacy provider numbers; only the display-privacy cases
// mount the provider.
const catalogue = vi.hoisted(() => ({ accounts: [] as Array<{ id: number; name: string }> }));
vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ accounts: catalogue.accounts }),
}));

const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The verdicts the route answers, written out rather than computed: the
 *  route's own test pins how it reaches them. */
const PERMITTED: AutoTradeVerdict = { permitted: true };
const LIVE: AutoTradeVerdict = { permitted: false, reason: LIVE_ACCOUNT_REFUSAL };
const UNVERIFIED: AutoTradeVerdict = { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL };
const STAGING_REFUSED: AutoTradeVerdict = { permitted: false, reason: STAGING_PRACTICE_ONLY_REFUSAL };

interface WireRow {
  /** Optional so a case can send a row from a route one deploy behind. */
  autoTrade?: AutoTradeVerdict;
  accountId: number;
  name: string | null;
  broker: "topstep" | "tradovate";
  practice: boolean | null;
  posture: { maxRiskPerTradeUsd: number; maxContracts: number } | null;
  dailyPnl?: {
    dailyMaxLossUsd: number;
    dailyMaxProfitUsd: number;
    dailyPnlIncludeUnrealized: boolean;
  };
  riskPhase?: {
    phase: AccountRiskPhase;
    mllUsd: number | null;
    startBalanceUsd: number | null;
    pressAtUsd?: number | null;
    payoutTakenAt: string | null;
  };
  eodSample?: {
    balanceUsd: number | null;
    peakUsd: number | null;
    sizesSessionStart: string | null;
    recordedAt: string | null;
  };
  brokerFacts?: {
    startingBalanceUsd: number | null;
    highestBalanceUsd: number | null;
    maximumLossUsd: number | null;
    dailyLossUsd: number | null;
    personalDailyLossLimitUsd: number | null;
    stage: number | null;
  } | null;
}

/**
 * `PRAC-V2-…` and `50KTC-…` are the shapes Topstep actually issues, confirmed
 * by the operator 2026-08-22 and recorded at `account-classification.ts`'s
 * `COMBINE_PREFIX` — the invented `COMBINE-…` fixtures are what let the old
 * `.includes("COMBINE")` predicate look correct while classifying every real
 * Combine account LIVE.
 */
const ROWS: WireRow[] = [
  {
    accountId: 5001,
    name: "PRAC-V2-100200-90012114",
    broker: "topstep",
    practice: true,
    posture: { maxRiskPerTradeUsd: 225, maxContracts: 3 },
    dailyPnl: { dailyMaxLossUsd: 675, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false },
    autoTrade: PERMITTED,
  },
  // No `dailyPnl` at all on the rest, which is the shape a stub or a rewritten
  // route hands back — every field the block reads off it is optional-chained,
  // so these render blank rather than throwing.
  { accountId: 5002, name: "50KTC-55555", broker: "topstep", practice: false, posture: null, autoTrade: PERMITTED },
  { accountId: 5003, name: "EXPRESS-98765", broker: "topstep", practice: false, posture: null, autoTrade: PERMITTED },
  {
    accountId: 5004,
    name: "TSTX-441122",
    broker: "topstep",
    practice: false,
    posture: { maxRiskPerTradeUsd: 500, maxContracts: 2 },
    autoTrade: LIVE,
  },
  // A catalogue row seeded before the `account_name` / `practice` columns.
  { accountId: 5005, name: null, broker: "topstep", practice: null, posture: null, autoTrade: UNVERIFIED },
];

/** What the route answers for `ROWS` on staging, where only practice trades. */
const STAGING_VERDICTS: Record<number, AutoTradeVerdict> = {
  5001: PERMITTED,
  5002: STAGING_REFUSED,
  5003: STAGING_REFUSED,
  5004: LIVE,
  5005: UNVERIFIED,
};
const onStaging = (rows: WireRow[]): WireRow[] =>
  rows.map((r) => ({ ...r, autoTrade: STAGING_VERDICTS[r.accountId] }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  // The evaluation classes are permitted on prod only, and the rows above
  // are two thirds evaluation accounts. The staging narrowing has its own
  // block at the bottom of this file.
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accounts: ROWS }) })),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AccountRiskBlock token="t" />);
  });
  await act(async () => {});
}

/**
 * An account's own `<tbody>` — one per account, holding its one or two `<tr>`s.
 *
 * The block became a table on 2026-09-13 (one account is a row, one setting is
 * a column, the labels are column headers) and this helper followed the
 * grouping rather than the markup: everything below still asks *what does this
 * account's row say*, which is what a `<tbody>` per account keeps true whether
 * the row renders one line or two.
 */
function rowFor(label: string): HTMLElement {
  const match = Array.from(container?.querySelectorAll("tbody") ?? []).find((el) =>
    el.textContent?.includes(label),
  );
  if (!match) throw new Error(`no row for ${label}`);
  return match as HTMLElement;
}

function inputsOf(row: HTMLElement): HTMLInputElement[] {
  return Array.from(row.querySelectorAll("input"));
}

/** Saves only. The mount's own `GET` would otherwise be counted as a write. */
function putCount(): number {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PUT")
    .length;
}

function buttonSaying(row: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(row.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`no ${label} button on the row`);
  return found as HTMLButtonElement;
}

describe("AccountRiskBlock — the table", () => {
  /**
   * The block was a stack of bordered panels, each field carrying its own
   * uppercase label, so six accounts printed thirty-odd labels for six
   * questions and no two rows' fields lined up. One header row is what
   * replaced them, and it is the rule every table in this app is held to.
   */
  it("labels its columns once, in the header, rather than once per field per row", async () => {
    await mount();
    // `toContain` rather than an equality: a header that carries an `InfoIcon`
    // has the glyph's own `i` in its text, and the assertion is about the
    // words being there once, in order.
    const headers = Array.from(container?.querySelectorAll("thead th") ?? []).map(
      (th) => th.textContent ?? "",
    );
    // The account heads its own band rather than taking a column.
    const expected = [
      "Risk per trade ($)",
      "Max contracts",
      "Daily limits ($)",
      "Account phase",
      "Actions",
    ];
    expect(headers).toHaveLength(expected.length);
    expected.forEach((label, i) => expect(headers[i]).toContain(label));
    // One `<tbody>` per account, and the account count is the row count —
    // nothing renders a header a second time further down.
    expect(container?.querySelectorAll("tbody").length).toBe(ROWS.length);
    expect(container?.querySelectorAll("thead").length).toBe(1);
  });

  // The Risk page's section header names it; a title here printed "Risk" twice.
  it("carries no title of its own", async () => {
    await mount();
    expect(container?.querySelectorAll("h1, h2, h3, h4").length).toBe(0);
  });

  it("says where the accounts would have come from when there are none", async () => {
    // An empty list otherwise reads as "there are none and there never will
    // be", which is the same class of lie as a plausible zero. It names the
    // producer — loading the Dashboard is what seeds the catalogue — and no
    // path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accounts: [] }) })),
    );
    await mount();
    expect(container?.textContent).toContain("No accounts yet");
    expect(container?.textContent).toContain("Dashboard");
    expect(container?.querySelector("table")).toBeNull();
  });

  it("says the read failed rather than showing an empty table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await mount();
    expect(container?.textContent).toContain("Could not load accounts");
    expect(container?.querySelector("table")).toBeNull();
  });
});

describe("AccountRiskBlock — which accounts are listed", () => {
  /** Rows carrying the status the check wrote. `PRAC-V2-…` and `50KTC-V2-…`
   *  are issued names, quoted in topstep.md. */
  const LISTED_ROWS = [
    {
      accountId: 7001,
      name: "50KTC-V2-100200-90020038",
      broker: "topstep",
      practice: false,
      posture: { maxRiskPerTradeUsd: 350, maxContracts: 3 },
      status: { state: "ok", checkedAt: "2026-10-14T21:00:00.000Z" },
      autoTrade: PERMITTED,
    },
    {
      accountId: 7002,
      name: "50KTC-V2-100200-11111111",
      broker: "topstep",
      practice: false,
      posture: null,
      status: { state: "dead", checkedAt: "2026-10-14T21:00:00.000Z" },
      autoTrade: PERMITTED,
    },
    {
      accountId: 7003,
      name: "PRAC-V2-100200-90012114",
      broker: "topstep",
      practice: true,
      posture: null,
      status: { state: "ok", checkedAt: "2026-10-14T21:00:00.000Z" },
      autoTrade: PERMITTED,
    },
  ];

  function stubRows(rows: unknown[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accounts: rows }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** Render, or re-render on the same root, with a status check the workbench
   *  would pass — a re-render is how the prop changes under a mounted block. */
  async function renderChecking(statusCheck: AccountStatusCheckState): Promise<void> {
    if (!root) {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(<AccountRiskBlock token="t" statusCheck={statusCheck} />);
    });
    await act(async () => {});
  }

  it("leaves out an account its broker reports dead, once nothing is set on it", async () => {
    stubRows(LISTED_ROWS);
    await mount();
    expect(container?.textContent).toContain("50KTC-V2-100200-90020038");
    expect(container?.textContent).not.toContain("50KTC-V2-100200-11111111");
    expect(container?.textContent).not.toContain(CLOSED_AT_BROKER_STAMP);
  });

  it("lists a dead account that still has a risk per trade, stamped, with Clear on it", async () => {
    stubRows([
      ...LISTED_ROWS,
      {
        accountId: 7004,
        name: "50KTC-V2-100200-22222222",
        broker: "topstep",
        practice: false,
        posture: { maxRiskPerTradeUsd: 350, maxContracts: 3 },
        status: { state: "dead", checkedAt: "2026-10-14T21:00:00.000Z" },
        autoTrade: PERMITTED,
      },
    ]);
    await mount();
    const closed = rowFor("50KTC-V2-100200-22222222");
    expect(closed.textContent).toContain(CLOSED_AT_BROKER_STAMP);
    expect(buttonSaying(closed, "Clear").disabled).toBe(false);
    // Only that row: an active one carries no stamp.
    expect(rowFor("50KTC-V2-100200-90020038").textContent).not.toContain(CLOSED_AT_BROKER_STAMP);
  });

  it("lists a locked account with nothing set on it, stamped, with the lock's reason and end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T21:30:00.000Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    stubRows([
      ...LISTED_ROWS,
      {
        accountId: 7005,
        name: "50KTC-V2-100200-33333333",
        broker: "topstep",
        practice: false,
        posture: null,
        status: {
          state: "locked",
          checkedAt: "2026-10-14T21:00:00.000Z",
          lockoutReason: "Daily loss limit",
          lockoutUntil: "2026-10-15T22:00:00.000Z",
        },
        autoTrade: PERMITTED,
      },
    ]);
    await mount();
    const locked = rowFor("50KTC-V2-100200-33333333");
    expect(locked.textContent).toContain(LOCKED_AT_BROKER_STAMP);
    expect(locked.textContent).not.toContain(CLOSED_AT_BROKER_STAMP);
    expect(locked.textContent).toContain(
      "Topstep has locked this account until Thu 15 Oct, 18:00 ET (Daily loss limit).",
    );
    // A lock decides nothing here: the row is armed and saved as any other.
    const risk = locked.querySelector<HTMLInputElement>(
      'input[aria-label="Risk per trade for 50KTC-V2-100200-33333333"]',
    );
    expect(risk?.disabled).toBe(false);
  });

  // The stored status is the last check's; once the end it named has passed,
  // saying "locked until" a time already gone is wrong.
  it("shows no lock once the lockout's end has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T22:00:01.000Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    stubRows([
      ...LISTED_ROWS,
      {
        accountId: 7005,
        name: "50KTC-V2-100200-33333333",
        broker: "topstep",
        practice: false,
        posture: null,
        status: {
          state: "locked",
          checkedAt: "2026-10-14T21:00:00.000Z",
          lockoutReason: "Daily loss limit",
          lockoutUntil: "2026-10-15T22:00:00.000Z",
        },
        autoTrade: PERMITTED,
      },
    ]);
    await mount();
    const row = rowFor("50KTC-V2-100200-33333333");
    expect(row.textContent).not.toContain(LOCKED_AT_BROKER_STAMP);
    expect(row.textContent).not.toContain("has locked this account");
  });

  it("drops the dead account once its risk is cleared", async () => {
    const armed = {
      accountId: 7004,
      name: "50KTC-V2-100200-22222222",
      broker: "topstep",
      practice: false,
      posture: { maxRiskPerTradeUsd: 350, maxContracts: 3 },
      status: { state: "dead", checkedAt: "2026-10-14T21:00:00.000Z" },
      autoTrade: PERMITTED,
    };
    stubRows([...LISTED_ROWS, armed]);
    await mount();
    // The PUT answers the catalogue as it stands after the clear.
    stubRows([...LISTED_ROWS, { ...armed, posture: null }]);
    const closed = () => rowFor("50KTC-V2-100200-22222222");
    await act(async () => buttonSaying(closed(), "Clear").click());
    await act(async () => buttonSaying(closed(), "Confirm?").click());
    await act(async () => {});
    expect(container?.textContent).not.toContain("50KTC-V2-100200-22222222");
  });

  it("leaves out a practice account on prod", async () => {
    stubRows(LISTED_ROWS);
    await mount();
    expect(container?.textContent).not.toContain("PRAC-V2-100200-90012114");
  });

  it("lists the same practice account off prod", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    stubRows(LISTED_ROWS);
    await mount();
    expect(container?.textContent).toContain("PRAC-V2-100200-90012114");
  });

  it("says the accounts it left out exist, rather than that there are none", async () => {
    stubRows(LISTED_ROWS.slice(1));
    await mount();
    expect(container?.textContent).not.toContain("No accounts yet");
    expect(container?.textContent).toContain("None of your accounts can trade right now");
    expect(container?.querySelector("table")).toBeNull();
  });

  it("re-reads the list once the open-time status check settles, and not before", async () => {
    const first = stubRows(LISTED_ROWS);
    await renderChecking({ kind: "checking" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Checking with your broker");

    // The check marked 7001 dead too. It carries a risk per trade, so it
    // stays listed, now stamped.
    expect(container?.textContent).not.toContain(CLOSED_AT_BROKER_STAMP);
    const second = stubRows(
      LISTED_ROWS.map((r) => (r.accountId === 7001 ? { ...r, status: { state: "dead" } } : r)),
    );
    await renderChecking({ kind: "done", failed: [] });
    expect(second).toHaveBeenCalledTimes(1);
    expect(rowFor("50KTC-V2-100200-90020038").textContent).toContain(CLOSED_AT_BROKER_STAMP);
    expect(container?.textContent).not.toContain("Checking with your broker");
  });

  it("keeps what the operator typed across that re-read", async () => {
    stubRows(LISTED_ROWS);
    await renderChecking({ kind: "checking" });
    const riskInput = () =>
      rowFor("50KTC-V2-100200-90020038").querySelector<HTMLInputElement>(
        'input[aria-label="Risk per trade for 50KTC-V2-100200-90020038"]',
      );
    await type(riskInput()!, "300");
    await renderChecking({ kind: "done", failed: [] });
    expect(riskInput()?.value).toBe("300");
  });

  it("says a broker that did not answer left its accounts as of the last check", async () => {
    stubRows(LISTED_ROWS);
    await renderChecking({ kind: "done", failed: ["topstep"] });
    expect(container?.textContent).toContain(
      "Topstep did not answer, so its accounts are listed as of the last check.",
    );
  });
});

describe("lockoutLine", () => {
  it("says plainly when the broker gave no end time, with or without a reason", () => {
    expect(lockoutLine("Topstep", "Manual", null)).toBe(
      "Topstep has locked this account (Manual) and gave no end time.",
    );
    expect(lockoutLine("Topstep", null, "not a time")).toBe(
      "Topstep has locked this account and gave no end time.",
    );
  });

  it("names the end without a reason when none was given", () => {
    expect(lockoutLine("Topstep", null, "2026-10-15T22:00:00.000Z")).toBe(
      "Topstep has locked this account until Thu 15 Oct, 18:00 ET.",
    );
  });
});

describe("AccountRiskBlock — account class", () => {
  it("names each account's class in the words a trader uses, not the export code", async () => {
    await mount();
    expect(rowFor("PRAC-V2-100200-90012114").textContent).toContain("PRACTICE");
    expect(rowFor("50KTC-55555").textContent).toContain("COMBINE");
    expect(rowFor("EXPRESS-98765").textContent).toContain("EXPRESS FUNDED");
    expect(rowFor("TSTX-441122").textContent).toContain("LIVE");
    expect(rowFor("Account 5005").textContent).toContain("UNCLASSIFIED");
  });
});

describe("AccountRiskBlock — a refused account", () => {
  it("stamps the live account, states the rule, and takes no budget", async () => {
    await mount();
    const row = rowFor("TSTX-441122");
    expect(row.textContent).toContain("no auto-trade");
    expect(row.textContent).toContain(LIVE_ACCOUNT_REFUSAL);
    for (const input of inputsOf(row)) expect(input.disabled).toBe(true);
    expect(buttonSaying(row, "Save").disabled).toBe(true);
  });

  it("gives the unclassifiable account its own recoverable sentence", async () => {
    await mount();
    const row = rowFor("Account 5005");
    expect(row.textContent).toContain("no auto-trade");
    expect(row.textContent).toContain(UNVERIFIED_ACCOUNT_REFUSAL);
    expect(row.textContent).not.toContain(LIVE_ACCOUNT_REFUSAL);
    for (const input of inputsOf(row)) expect(input.disabled).toBe(true);
    expect(buttonSaying(row, "Save").disabled).toBe(true);
  });

  it("leaves Clear live, because disarming a refused account is the wind-down", async () => {
    await mount();
    // 5004 is refused *and* already carries a posture — the one row where the
    // refusal could trap a budget the operator wants gone.
    expect(buttonSaying(rowFor("TSTX-441122"), "Clear").disabled).toBe(false);
  });

  /**
   * `onSave` repeats the row's refusal check, and that guard is deliberately
   * **not** asserted here. React reads `props.disabled` rather than the DOM
   * node's, so clearing the attribute and dispatching a click reaches no
   * listener at all — a bypass test written that way is green with the guard
   * deleted, which was verified by injection rather than reasoned about. Same
   * conclusion design-language.md already records for the leg picker's
   * handler: not testable through the DOM, so it is written down instead.
   *
   * What is asserted is the other half — a permitted row does press through —
   * because without it every "no request went out" claim in this file would
   * hold against a harness that cannot fire the handler at all.
   */
  it("submits a permitted row, which is what makes the disabled assertions mean anything", async () => {
    await mount();
    const before = putCount();
    await act(async () => {
      buttonSaying(rowFor("PRAC-V2-100200-90012114"), "Save").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(putCount()).toBe(before + 1);
  });
});

/**
 * A38: the verdict is the row's `autoTrade`, which the route reads from the
 * catalogue. Recomputing it from the name could not see a catalogue row the
 * seed failed to write, so a practice-named account the server refuses must
 * render refused here.
 */
describe("AccountRiskBlock — the server's verdict", () => {
  const PRAC_UNVERIFIED: WireRow = {
    accountId: 5030,
    name: "PRAC-V2-100200-77777777",
    broker: "topstep",
    practice: true,
    posture: { maxRiskPerTradeUsd: 225, maxContracts: 3 },
    autoTrade: UNVERIFIED,
  };

  it("A38 — renders a refused row's refusal from the row's field, though its name is a practice name", async () => {
    await mountWith([PRAC_UNVERIFIED]);
    const row = rowFor("PRAC-V2-100200-77777777");
    expect(row.textContent).toContain("PRACTICE");
    expect(row.textContent).toContain("no auto-trade");
    expect(row.textContent).toContain(UNVERIFIED_ACCOUNT_REFUSAL);
    for (const input of inputsOf(row)) expect(input.disabled).toBe(true);
    expect(buttonSaying(row, "Save").disabled).toBe(true);
  });

  it("A38 — refuses a row the route sent without a verdict", async () => {
    const stale: WireRow = { ...PRAC_UNVERIFIED, autoTrade: undefined };
    await mountWith([stale]);
    const row = rowFor("PRAC-V2-100200-77777777");
    expect(row.textContent).toContain(UNVERIFIED_ACCOUNT_REFUSAL);
    expect(buttonSaying(row, "Save").disabled).toBe(true);
  });

  it.each([
    ["permitted: 1", { permitted: 1 }],
    ["permitted: \"false\"", { permitted: "false" }],
    ["an empty object", {}],
  ])("refuses a row whose verdict is malformed (%s), though it is truthy at `permitted` or carries no reason", async (_label, autoTrade) => {
    const malformed = { ...PRAC_UNVERIFIED, autoTrade } as unknown as WireRow;
    await mountWith([malformed]);
    const row = rowFor("PRAC-V2-100200-77777777");
    expect(row.textContent).toContain(UNVERIFIED_ACCOUNT_REFUSAL);
    expect(buttonSaying(row, "Save").disabled).toBe(true);
  });

  it("A38 — never calls autoTradeVerdict", async () => {
    vi.mocked(autoTradeVerdict).mockClear();
    await mount();
    expect(rowFor("TSTX-441122").textContent).toContain(LIVE_ACCOUNT_REFUSAL);
    expect(autoTradeVerdict).not.toHaveBeenCalled();
  });
});

describe("AccountRiskBlock — a permitted account", () => {
  it("stays editable and unstamped", async () => {
    await mount();
    for (const label of ["PRAC-V2-100200-90012114", "50KTC-55555", "EXPRESS-98765"]) {
      const row = rowFor(label);
      expect(row.textContent).not.toContain("no auto-trade");
      for (const input of inputsOf(row)) expect(input.disabled).toBe(false);
      expect(buttonSaying(row, "Save").disabled).toBe(false);
    }
  });
});

/**
 * Below `sm` the field mode lays out on a two-column grid; from `sm` to `lg`
 * it is the wrap it was, and from `lg` the table. jsdom applies no media
 * query, so the classes are what is pinned, and that each phone class has
 * its `sm:` undo beside it.
 */
describe("AccountRiskBlock — the phone layout", () => {
  function classesOf(el: Element | null | undefined): string[] {
    return el?.className.split(/\s+/) ?? [];
  }

  /** The settings line: the `<tr>` holding the phase select. */
  function settingsLine(label: string): HTMLTableRowElement {
    return selectOf(rowFor(label)).closest("tr")!;
  }

  const ARMED = "PRAC-V2-100200-90012114";

  it("lays the settings line on a two-column grid below sm, the wrap from sm and the table from lg", async () => {
    await mount();
    expect(classesOf(settingsLine(ARMED))).toEqual(
      expect.arrayContaining(["grid", "grid-cols-2", "sm:flex", "sm:flex-wrap", "lg:table-row"]),
    );
  });

  it("puts risk per trade and max contracts side by side, one column each", async () => {
    await mount();
    const [risk, contracts] = Array.from(settingsLine(ARMED).children);
    expect(risk.querySelector("input")?.getAttribute("aria-label")).toContain("Risk per trade");
    expect(contracts.querySelector("input")?.getAttribute("aria-label")).toContain("Max contracts");
    for (const cell of [risk, contracts]) expect(classesOf(cell)).not.toContain("col-span-2");
    expect(classesOf(risk.querySelector("input"))).toEqual(expect.arrayContaining(["w-full", "sm:w-24"]));
    expect(classesOf(contracts.querySelector("input"))).toEqual(expect.arrayContaining(["w-full", "sm:w-16"]));
  });

  it("gives the two daily limits the next line, side by side", async () => {
    await mount();
    const daily = settingsLine(ARMED).children[2];
    expect(classesOf(daily)).toEqual(expect.arrayContaining(["col-span-2", "sm:col-span-1"]));
    const pair = daily.querySelector("label")!.parentElement!;
    expect(classesOf(pair)).toEqual(expect.arrayContaining(["grid", "grid-cols-2", "sm:flex", "sm:flex-wrap"]));
    expect(pair.querySelectorAll("input")).toHaveLength(2);
  });

  it("gives the account phase a full line", async () => {
    await mount();
    const phase = settingsLine(ARMED).children[3];
    expect(phase.querySelector("select")).not.toBeNull();
    expect(classesOf(phase)).toEqual(expect.arrayContaining(["col-span-2", "sm:col-span-1"]));
    expect(classesOf(phase.querySelector("select"))).toEqual(expect.arrayContaining(["w-full", "sm:w-56"]));
  });

  it("ends on a line of its own with Save filling it and Clear beside it at its natural width", async () => {
    await mount();
    const actions = settingsLine(ARMED).children[4];
    expect(classesOf(actions)).toEqual(expect.arrayContaining(["col-span-2", "sm:col-span-1", "sm:ml-auto", "lg:ml-0"]));
    // A bare ml-auto would shrink the cell to its content inside the grid.
    expect(classesOf(actions)).not.toContain("ml-auto");
    const save = buttonSaying(rowFor(ARMED), "Save");
    const clear = buttonSaying(rowFor(ARMED), "Clear");
    expect(classesOf(save)).toEqual(expect.arrayContaining(["flex-1", "sm:flex-initial"]));
    expect(classesOf(clear)).not.toContain("flex-1");
    expect(clear.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(classesOf(save.parentElement)).toEqual(expect.arrayContaining(["flex", "w-full", "sm:inline-flex", "sm:w-auto"]));
  });

  it("makes every input and the select a 44px target below sm and desk height from sm", async () => {
    await mount();
    const row = rowFor(ARMED);
    const controls = [...inputsOf(row), selectOf(row)];
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const el of controls) {
      expect(classesOf(el)).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-0"]));
    }
  });
});

/**
 * *The account phase is a declaration with rules attached, and the rules are
 * the reason it is on screen at all.*
 *
 * Two things below the DOM would pass with the form unwired: the budget line
 * is `resolveSessionBudget` — pinned to the cent in its own suite — and the
 * four refusals are constants the route answers. What only a DOM can say is
 * that the operator meets them: that the select carries the options in the
 * order that puts the safest first, that a phase the account's history rules
 * out cannot be picked, and that Save sends the three fields the route reads.
 */
const SESSION_NOW = new Date();

/** A row's own catalogue shape, with the phase columns the block reads. */
function combineRow(overrides: Partial<WireRow> = {}): WireRow {
  return {
    accountId: 5010,
    name: "50KTC-77777",
    broker: "topstep",
    practice: false,
    posture: { maxRiskPerTradeUsd: 500, maxContracts: 3 },
    riskPhase: { phase: "combine", mllUsd: 2000, startBalanceUsd: 50000, payoutTakenAt: null },
    // Peak 51,000 → floor 49,000; close 50,750 → headroom 1,750 → the top
    // bucket. The stamp has to be *this* session's or the sample is stale by
    // construction, which is the other case below.
    eodSample: {
      balanceUsd: 50750,
      peakUsd: 51000,
      sizesSessionStart: currentCmeSessionStart(SESSION_NOW),
      recordedAt: SESSION_NOW.toISOString(),
    },
    autoTrade: PERMITTED,
    ...overrides,
  };
}

const NO_SAMPLE = { balanceUsd: null, peakUsd: null, sizesSessionStart: null, recordedAt: null };

/**
 * Mount over a given catalogue, answering `PUT` with `onPut` when one is
 * supplied. The stub is a recorder rather than a return value: what the tests
 * below assert is the request body, which is the only place the phase write
 * exists before it reaches a server.
 */
async function mountWith(
  rows: WireRow[],
  onPut?: () => { ok: boolean; status: number; body: unknown },
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === "PUT") {
        const answer = onPut?.() ?? { ok: true, status: 200, body: { accounts: rows } };
        return { ok: answer.ok, status: answer.status, json: async () => answer.body };
      }
      return { ok: true, status: 200, json: async () => ({ accounts: rows }) };
    }),
  );
  await mount();
}

function selectOf(row: HTMLElement): HTMLSelectElement {
  const found = row.querySelector("select");
  if (!found) throw new Error("no phase select on the row");
  return found as HTMLSelectElement;
}

/** React installs a value tracker over the node, so an assignment leaves it in
 *  sync and no handler fires — write through the prototype setter and dispatch
 *  the event the control really emits. */
async function pick(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function lastPutBody(): Record<string, unknown> {
  const call = vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === "PUT")
    .pop();
  if (!call) throw new Error("no PUT went out");
  return JSON.parse(String((call[1] as { body?: unknown }).body)) as Record<string, unknown>;
}

describe("AccountRiskBlock — the account phase", () => {
  it("offers the five phases, safest first, combine_press last", async () => {
    await mountWith([combineRow()]);
    const options = Array.from(selectOf(rowFor("50KTC-77777")).options);
    expect(options.map((o) => o.textContent?.split(" — ")[0])).toEqual([
      ACCOUNT_RISK_PHASE_LABELS.off,
      ACCOUNT_RISK_PHASE_LABELS.funded_paid,
      ACCOUNT_RISK_PHASE_LABELS.funded_fresh,
      ACCOUNT_RISK_PHASE_LABELS.combine,
      ACCOUNT_RISK_PHASE_LABELS.combine_press,
    ]);
  });

  it("combine_press: shows the press threshold for that phase alone, prefilled at 1500", async () => {
    await mountWith([combineRow()]);
    expect(rowFor("50KTC-77777").querySelector("#account-press-at-5010")).toBeNull();
    await pick(selectOf(rowFor("50KTC-77777")), "combine_press");
    const field = rowFor("50KTC-77777").querySelector("#account-press-at-5010") as HTMLInputElement | null;
    expect(field?.value).toBe("1500");
    expect(rowFor("50KTC-77777").querySelector("#account-mll-5010")).not.toBeNull();
    await pick(selectOf(rowFor("50KTC-77777")), "combine");
    expect(rowFor("50KTC-77777").querySelector("#account-press-at-5010")).toBeNull();
  });

  it("combine_press: keeps a typed threshold across a phase change and sends it on Save", async () => {
    await mountWith([combineRow()]);
    await pick(selectOf(rowFor("50KTC-77777")), "combine_press");
    await type(rowFor("50KTC-77777").querySelector("#account-press-at-5010") as HTMLInputElement, "2000");
    await pick(selectOf(rowFor("50KTC-77777")), "combine");
    await pick(selectOf(rowFor("50KTC-77777")), "combine_press");
    await press(buttonSaying(rowFor("50KTC-77777"), "Save"));
    expect(lastPutBody()).toMatchObject({
      riskPhase: "combine_press",
      mllUsd: 2000,
      startBalanceUsd: 50000,
      pressAtUsd: 2000,
    });
  });

  it("names no press threshold for a phase that does not read it", async () => {
    await mountWith([combineRow()]);
    await press(buttonSaying(rowFor("50KTC-77777"), "Save"));
    expect("pressAtUsd" in lastPutBody()).toBe(false);
  });

  it("combine_press: closed once a payout is stamped", async () => {
    await mountWith([
      combineRow({
        riskPhase: { phase: "funded_paid", mllUsd: null, startBalanceUsd: null, payoutTakenAt: "2026-09-01T12:00:00.000Z" },
        eodSample: NO_SAMPLE,
      }),
    ]);
    const option = Array.from(selectOf(rowFor("50KTC-77777")).options).find((o) => o.value === "combine_press");
    expect(option?.disabled).toBe(true);
    expect(option?.title).toBe(POST_PAYOUT_PHASE_REFUSAL);
  });

  it("shows the two rule parameters for the phases that read them, and only those", async () => {
    await mountWith([combineRow({ riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null }, eodSample: NO_SAMPLE })]);
    const row = rowFor("50KTC-77777");
    expect(row.querySelector("#account-mll-5010")).toBeNull();
    await pick(selectOf(row), "combine");
    expect(rowFor("50KTC-77777").querySelector("#account-mll-5010")).not.toBeNull();
    expect(rowFor("50KTC-77777").querySelector("#account-start-balance-5010")).not.toBeNull();
    await pick(selectOf(rowFor("50KTC-77777")), "off");
    expect(rowFor("50KTC-77777").querySelector("#account-mll-5010")).toBeNull();
    expect(rowFor("50KTC-77777").querySelector("#account-start-balance-5010")).toBeNull();
  });

  it("sends the phase and its two rule parameters on Save", async () => {
    await mountWith([combineRow()]);
    await press(buttonSaying(rowFor("50KTC-77777"), "Save"));
    expect(lastPutBody()).toMatchObject({
      accountId: 5010,
      riskPhase: "combine",
      mllUsd: 2000,
      startBalanceUsd: 50000,
    });
  });

  it("names neither rule parameter for a phase that stores neither", async () => {
    await mountWith([combineRow()]);
    await pick(selectOf(rowFor("50KTC-77777")), "off");
    await press(buttonSaying(rowFor("50KTC-77777"), "Save"));
    const body = lastPutBody();
    expect(body.riskPhase).toBe("off");
    expect("mllUsd" in body).toBe(false);
    expect("startBalanceUsd" in body).toBe(false);
  });

  it("offers Off alone on a Tradovate row, and says why", async () => {
    await mountWith([
      {
        accountId: 5011,
        name: "DEMO-TRADOVATE-1",
        broker: "tradovate",
        practice: true,
        posture: { maxRiskPerTradeUsd: 225, maxContracts: 3 },
        riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null },
        eodSample: NO_SAMPLE,
        autoTrade: PERMITTED,
      },
    ]);
    const select = selectOf(rowFor("DEMO-TRADOVATE-1"));
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["off"]);
    expect(select.title).toBe(NON_TOPSTEP_PHASE_REFUSAL);
  });

  it("renders the select at Off on a Tradovate row carrying a stored combine phase", async () => {
    // A row re-tagged Tradovate after a phase save keeps whatever it was
    // last saved as — here still "combine" — but `phaseOptions` above offers
    // only Off, so rendering `draft.phase` verbatim would hand the select a
    // value with no matching option.
    await mountWith([
      {
        accountId: 5012,
        name: "DEMO-TRADOVATE-2",
        broker: "tradovate",
        practice: true,
        posture: { maxRiskPerTradeUsd: 225, maxContracts: 3 },
        riskPhase: { phase: "combine", mllUsd: 2000, startBalanceUsd: 50000, payoutTakenAt: null },
        eodSample: NO_SAMPLE,
        autoTrade: PERMITTED,
      },
    ]);
    const select = selectOf(rowFor("DEMO-TRADOVATE-2"));
    expect(select.value).toBe("off");
    expect(select.selectedIndex).not.toBe(-1);
  });

  it("closes the combine side of the select once a payout is stamped", async () => {
    await mountWith([
      combineRow({
        riskPhase: {
          phase: "funded_paid",
          mllUsd: null,
          startBalanceUsd: null,
          payoutTakenAt: "2026-09-01T12:00:00.000Z",
        },
        eodSample: NO_SAMPLE,
      }),
    ]);
    const options = Object.fromEntries(
      Array.from(selectOf(rowFor("50KTC-77777")).options).map((o) => [o.value, o]),
    );
    expect(options.combine.disabled).toBe(true);
    expect(options.funded_fresh.disabled).toBe(true);
    expect(options.combine.title).toBe(POST_PAYOUT_PHASE_REFUSAL);
    expect(options.off.disabled).toBe(false);
    expect(options.funded_paid.disabled).toBe(false);
  });

  it("refuses a combine on any other loss limit at the field, with the route's own sentence", async () => {
    await mountWith([combineRow()]);
    const before = putCount();
    const field = rowFor("50KTC-77777").querySelector("#account-mll-5010") as HTMLInputElement;
    await type(field, "3000");
    await press(buttonSaying(rowFor("50KTC-77777"), "Save"));
    expect(putCount()).toBe(before);
    expect(rowFor("50KTC-77777").textContent).toContain(COMBINE_MLL_REFUSAL);
  });

  it("renders a refusal the server answers, verbatim", async () => {
    await mountWith(
      [combineRow({ riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null }, eodSample: NO_SAMPLE })],
      () => ({ ok: false, status: 400, body: { error: PAYOUT_PHASE_PATH_REFUSAL } }),
    );
    await pick(selectOf(rowFor("50KTC-77777")), "funded_paid");
    await press(buttonSaying(rowFor("50KTC-77777"), "Save"));
    expect(rowFor("50KTC-77777").textContent).toContain(PAYOUT_PHASE_PATH_REFUSAL);
  });
});

describe("AccountRiskBlock — today's budget", () => {
  it("states the budget and the facts behind it from the recorded close", async () => {
    await mountWith([combineRow()]);
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain("Today's budget $500");
    expect(text).toContain("headroom $1,750");
    expect(text).toContain("floor $49,000");
    expect(text).toContain("sized from the close of");
  });

  it("says the phase is on its lowest budget when no close is on record", async () => {
    await mountWith([combineRow({ eodSample: NO_SAMPLE })]);
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain("Today's budget $225 (lowest)");
    expect(text).toContain("no close on record yet");
  });

  // Headroom $1,750 against a $1,500 threshold: the press rung.
  const pressRow = (maxRiskPerTradeUsd: number) =>
    combineRow({
      posture: { maxRiskPerTradeUsd, maxContracts: 3 },
      riskPhase: { phase: "combine_press", mllUsd: 2000, startBalanceUsd: 50000, pressAtUsd: 1500, payoutTakenAt: null },
    });

  it("combine_press: states the press budget and the facts behind it", async () => {
    await mountWith([pressRow(500)]);
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain("Today's budget $500 · headroom $1,750 · floor $49,000");
    expect(text).not.toContain("caps the");
  });

  it("combine_press: says a $350 risk per trade caps the press", async () => {
    await mountWith([pressRow(350)]);
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain("Today's budget $350 · headroom $1,750");
    expect(text).toContain("risk per trade $350 caps the $500 press");
  });

  it("combine_press: names no cap when the headroom is under the threshold", async () => {
    // Close 50,000 over the 49,000 floor: headroom $1,000 against $1,500, so
    // the headroom set $350 and the ceiling did not bind.
    await mountWith([
      {
        ...pressRow(350),
        eodSample: {
          balanceUsd: 50000,
          peakUsd: 51000,
          sizesSessionStart: currentCmeSessionStart(SESSION_NOW),
          recordedAt: SESSION_NOW.toISOString(),
        },
      },
    ]);
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain("Today's budget $350 · headroom $1,000");
    expect(text).not.toContain("caps the");
  });

  it("combine_press: runs $350 (lowest) with no close on record", async () => {
    await mountWith([{ ...pressRow(500), eodSample: NO_SAMPLE }]);
    expect(rowFor("50KTC-77777").textContent).toContain("Today's budget $350 (lowest)");
  });

  it("combine_press: a row with no threshold renders the resolver's refusal", async () => {
    await mountWith([
      combineRow({
        riskPhase: { phase: "combine_press", mllUsd: 2000, startBalanceUsd: 50000, pressAtUsd: null, payoutTakenAt: null },
      }),
    ]);
    expect(rowFor("50KTC-77777").textContent).toContain(
      phaseRuleParameterRefusal("press threshold", null),
    );
  });

  it("renders nothing for an account whose phase is off", async () => {
    await mountWith([
      combineRow({
        riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null },
        eodSample: NO_SAMPLE,
      }),
    ]);
    expect(rowFor("50KTC-77777").textContent).not.toContain("Today's budget");
  });
});

describe("AccountRiskBlock — the budget line's clock", () => {
  /**
   * `budgetLineOf` used to read `new Date()` at render, so a tab left open
   * across the session roll kept showing a stale close as today's. The fix is
   * a one-minute tick on a `now` state; this pins that the line re-renders
   * from the tick alone, with no click and no re-fetch.
   */
  it("re-renders across the session rollover with no other trigger", async () => {
    // Wed 2026-09-09, 16:59 ET — inside the session opened Tue 18:00 ET.
    const beforeRollover = new Date("2026-09-09T20:59:00.000Z");
    // One minute later, 17:00 ET, is where `currentCmeSessionStart` flips to
    // the session opening today 18:00 ET — the close below is stamped for
    // the session that just ended and goes stale at exactly this instant.
    const afterRollover = new Date("2026-09-09T21:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(beforeRollover);
    try {
      await mountWith([
        combineRow({
          eodSample: {
            balanceUsd: 50750,
            peakUsd: 51000,
            sizesSessionStart: currentCmeSessionStart(beforeRollover),
            recordedAt: beforeRollover.toISOString(),
          },
        }),
      ]);
      expect(rowFor("50KTC-77777").textContent).toContain("Today's budget $500");

      vi.setSystemTime(afterRollover);
      // The component's own tick interval, not a re-fetch or a click.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(rowFor("50KTC-77777").textContent).toContain("Today's budget $225 (lowest)");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AccountRiskBlock — on staging", () => {
  /**
   * The block renders the server's `verdict.reason` verbatim, so the
   * environment rule needs nothing here: an evaluation account picks up the
   * stamp, the disable and the staging sentence with nothing in the component
   * branching on the environment. The class badge is asserted alongside — the
   * row still says COMBINE, because a refusal is not a class. The env stub is
   * for `listedOnRisk`, which is the only thing here that reads it.
   */
  // Staging lists a non-practice account only while it still carries a risk
  // per trade, so the evaluation row here is an armed one.
  it("stamps an evaluation account and gives the staging reason, not the live one", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    await mountWith(
      onStaging(ROWS).map((r) =>
        r.accountId === 5002 ? { ...r, posture: { maxRiskPerTradeUsd: 350, maxContracts: 3 } } : r,
      ),
    );
    const row = rowFor("50KTC-55555");
    expect(row.textContent).toContain("no auto-trade");
    expect(row.textContent).toContain("COMBINE");
    expect(row.textContent).toContain(STAGING_PRACTICE_ONLY_REFUSAL);
    expect(row.textContent).not.toContain(LIVE_ACCOUNT_REFUSAL);
    for (const input of inputsOf(row)) expect(input.disabled).toBe(true);
    expect(buttonSaying(row, "Save").disabled).toBe(true);
  });

  it("leaves the practice account editable, and keeps the live one refused as live", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    await mountWith(onStaging(ROWS));
    const practice = rowFor("PRAC-V2-100200-90012114");
    expect(practice.textContent).not.toContain("no auto-trade");
    for (const input of inputsOf(practice)) expect(input.disabled).toBe(false);
    expect(rowFor("TSTX-441122").textContent).toContain(LIVE_ACCOUNT_REFUSAL);
  });

  it("leaves out a non-practice account with nothing set on it", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    await mountWith(onStaging(ROWS));
    expect(container?.textContent).not.toContain("50KTC-55555");
    expect(container?.textContent).not.toContain("EXPRESS-98765");
  });
});

/**
 * Topstep's suggestions: filled into empty fields only, marked until edited or
 * saved, never into risk per trade or max contracts, and never Topstep's own
 * daily loss limit into the operator's gate.
 */
describe("AccountRiskBlock — suggestions from Topstep", () => {
  /** A live 50K combine as Topstep's website reported it, its floor trailed up. */
  const COMBINE_FACTS = {
    startingBalanceUsd: 50_000,
    highestBalanceUsd: 51_969.94,
    maximumLossUsd: 49_969.94,
    dailyLossUsd: 1_000,
    personalDailyLossLimitUsd: null,
    stage: 1,
  };

  /** Never saved: no risk per trade, phase off, nothing typed anywhere. */
  function freshRow(facts: WireRow["brokerFacts"] = COMBINE_FACTS): WireRow {
    return {
      accountId: 5020,
      name: "50KTC-88888",
      broker: "topstep",
      practice: false,
      posture: null,
      dailyPnl: { dailyMaxLossUsd: 0, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false },
      riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null },
      brokerFacts: facts,
      autoTrade: PERMITTED,
    };
  }

  const field = (id: string) => container!.querySelector(`#${id}`) as HTMLInputElement;
  const badges = (row: HTMLElement) =>
    Array.from(row.querySelectorAll("span")).filter((s) => s.textContent === FROM_TOPSTEP_BADGE).length;

  it("fills the empty fields, marks each one, and leaves risk per trade and max contracts blank", async () => {
    await mountWith([freshRow()]);
    const row = rowFor("50KTC-88888");
    expect(selectOf(row).value).toBe("combine");
    // highestBalance − maximumLoss, in cents: the trailed floor's gap.
    expect(field("account-mll-5020").value).toBe("2000");
    expect(field("account-start-balance-5020").value).toBe("50000");
    const [risk, contracts, dailyLoss] = inputsOf(row);
    expect(risk!.value).toBe("");
    expect(contracts!.value).toBe("");
    expect(badges(row)).toBe(3);
    // Topstep's own limit is said beside the gate, never typed into it.
    expect(dailyLoss!.value).toBe("");
    expect(row.textContent).toContain(topstepDailyLossLine(1_000));
    expect(row.textContent).toContain("Topstep daily loss limit $1,000");
  });

  it("fills the daily loss field from the operator's own Topstep limit, not the program's", async () => {
    await mountWith([freshRow({ ...COMBINE_FACTS, personalDailyLossLimitUsd: 600 })]);
    const row = rowFor("50KTC-88888");
    expect(inputsOf(row)[2]!.value).toBe("600");
    expect(badges(row)).toBe(4);
  });

  it("never overwrites a saved value, and suggests no phase or daily loss on a saved account", async () => {
    await mountWith([
      {
        ...freshRow(),
        posture: { maxRiskPerTradeUsd: 350, maxContracts: 3 },
        dailyPnl: { dailyMaxLossUsd: 0, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false },
        riskPhase: { phase: "funded_fresh", mllUsd: 2500, startBalanceUsd: 0, payoutTakenAt: null },
        brokerFacts: { ...COMBINE_FACTS, personalDailyLossLimitUsd: 600 },
      },
    ]);
    const row = rowFor("50KTC-88888");
    expect(selectOf(row).value).toBe("funded_fresh");
    expect(field("account-mll-5020").value).toBe("2500");
    expect(field("account-start-balance-5020").value).toBe("0");
    // A saved account's daily loss "off" is the operator's choice.
    expect(inputsOf(row)[2]!.value).toBe("");
    expect(badges(row)).toBe(0);
  });

  it("drops the mark from a field the operator edits, and keeps what they typed", async () => {
    await mountWith([freshRow()]);
    await type(field("account-mll-5020"), "2100");
    const row = rowFor("50KTC-88888");
    expect(field("account-mll-5020").value).toBe("2100");
    expect(badges(row)).toBe(2);
  });

  it("drops every mark once a save lands, and sends the suggestions as the operator's values", async () => {
    const saved: WireRow = {
      ...freshRow(),
      posture: { maxRiskPerTradeUsd: 350, maxContracts: 3 },
      riskPhase: { phase: "combine", mllUsd: 2000, startBalanceUsd: 50000, payoutTakenAt: null },
    };
    await mountWith([freshRow()], () => ({ ok: true, status: 200, body: { accounts: [saved] } }));
    const row = rowFor("50KTC-88888");
    const [risk, contracts] = inputsOf(row);
    await type(risk!, "350");
    await type(contracts!, "3");
    await press(buttonSaying(row, "Save"));
    expect(lastPutBody()).toMatchObject({
      maxRiskPerTradeUsd: 350,
      maxContracts: 3,
      riskPhase: "combine",
      mllUsd: 2000,
      startBalanceUsd: 50000,
      dailyMaxLossUsd: 0,
    });
    expect(badges(rowFor("50KTC-88888"))).toBe(0);
  });

  it("suggests nothing for an account whose last check did not hear Topstep's website", async () => {
    await mountWith([freshRow(null)]);
    const row = rowFor("50KTC-88888");
    expect(selectOf(row).value).toBe("off");
    expect(badges(row)).toBe(0);
    expect(row.textContent).not.toContain("Topstep daily loss limit");
  });
});

describe("AccountRiskBlock — display privacy", () => {
  // 4000 sorts first, so the combine row (5010) is Account 2.
  beforeEach(() => {
    localStorage.clear();
    catalogue.accounts = [
      { id: 5010, name: "50KTC-77777" },
      { id: 4000, name: "PRAC-V2-100200-90012114" },
    ];
  });

  async function mountPrivate(rows: WireRow[], flags: { ids?: boolean; balances?: boolean }): Promise<void> {
    if (flags.ids) localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    if (flags.balances) localStorage.setItem(HIDE_BALANCES_KEY, "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accounts: rows }) })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PrivacyProvider>
          <AccountRiskBlock token="t" />
        </PrivacyProvider>,
      );
    });
    await act(async () => {});
  }

  const startBalance = () => container!.querySelector<HTMLInputElement>("#account-start-balance-5010")!;

  it("reads Account N in the account band and every aria-label while IDs are hidden", async () => {
    await mountPrivate([combineRow()], { ids: true });
    const row = rowFor("Account 2");
    expect(row.textContent).not.toContain("50KTC-77777");
    const labels = Array.from(row.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label"));
    expect(labels).toContain("Risk per trade for Account 2");
    expect(labels).toContain("Max contracts for Account 2");
    expect(labels).toContain("Account phase for Account 2");
    expect(labels.join(" ")).not.toContain("50KTC-77777");
  });

  it("reads $xx,xxx.xx read-only in Starting balance and masks headroom and floor, keeping the budget", async () => {
    await mountPrivate([combineRow()], { balances: true });
    const field = startBalance();
    expect(field.value).toBe(MASKED_USD);
    expect(field.readOnly).toBe(true);
    expect(field.title).toBe(START_BALANCE_HIDDEN_TITLE);
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain(`Today's budget $500 · headroom ${MASKED_USD} · floor ${MASKED_USD}`);
    expect(text).not.toContain("$49,000");
  });

  it("masks the close and floor in an at-floor refusal while balances are hidden", async () => {
    const atFloor = combineRow({
      eodSample: {
        balanceUsd: 49000,
        peakUsd: 51000,
        sizesSessionStart: currentCmeSessionStart(SESSION_NOW),
        recordedAt: SESSION_NOW.toISOString(),
      },
    });
    await mountPrivate([atFloor], { balances: true });
    const text = rowFor("50KTC-77777").textContent ?? "";
    expect(text).toContain(maskUsdFigures(accountAtFloorRefusal(49_000, 49_000), true));
    expect(text).toContain(`last closed at ${MASKED_USD}`);
    expect(text).not.toContain("$49,000");
  });

  it("shows the name and the editable starting balance with the switches off", async () => {
    await mountPrivate([combineRow()], {});
    const row = rowFor("50KTC-77777");
    expect(row.textContent).not.toContain("Account 2");
    expect(row.querySelector("[aria-label='Risk per trade for 50KTC-77777']")).not.toBeNull();
    const field = startBalance();
    expect(field.value).toBe("50000");
    expect(field.readOnly).toBe(false);
    expect(row.textContent).toContain("headroom $1,750 · floor $49,000");
  });
});
