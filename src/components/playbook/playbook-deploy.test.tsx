// @vitest-environment jsdom
/**
 * What only a DOM can show about the Deploy control: that the header button
 * is disabled with its reason, and that a funded account's row renders —
 * visible, disabled, stamped and titled — rather than being dropped.
 *
 * The handler half of each refusal is `playbook-deploy-model.test.ts`'s:
 * React drops events on a control it rendered `disabled`, so stripping the
 * attribute here would pass against a handler with no guard in it.
 *
 * The panel's press is here too, because its failures live between awaits in
 * the component: the double-press latch before the prompts, and what the
 * failure line says about a row the rollback did or did not remove. The hooks
 * and the prompt are mocked at their module seams; the model is not.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlaybookDeployAccounts, PlaybookDeployButton, PlaybookDeployPanel } from "./playbook-deploy";
import { PrivacyProvider } from "@/components/privacy/privacy-provider";
import { HIDE_ACCOUNT_IDS_KEY } from "@/components/privacy/privacy-model";
import {
  buildDeployAccountRows,
  DEPLOY_CHECKING_ACCOUNTS,
  DEPLOY_INTERRUPTED,
  DEPLOY_LIST_LOADING,
  DEPLOY_ROLLBACK_FAILED,
  DEPLOY_ROLLED_BACK,
  DEPLOY_UNREACHABLE,
  NO_CALIBRATED_INSTRUMENT_REASON,
  sameContractWarning,
} from "./playbook-deploy-model";
import type { AccountRow } from "@/lib/hooks/use-trading/account-row";
import type { DeploymentsLoadState } from "@/lib/hooks/use-strategies";
import {
  autoTradeVerdict,
  LIVE_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";
import {
  ACCOUNT_DEAD_REFUSAL,
  AUTO_OCO_OFF_REFUSAL,
  AUTO_OCO_UNKNOWN_REFUSAL,
  MOVE_TO_REPLACEMENT_LABEL,
  autoBracketWarning,
  lockedRefusal,
} from "@/lib/trading/broker-access/account-state-gate";
import type { StrategyConfig } from "@/lib/trading/strategy-types";
import { NO_BROKER_COPY } from "@/lib/hooks/use-trading/auth-answer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
  const prac = {
    id: 1,
    name: "PRAC-V2-100200-90012114",
    balance: 0,
    canTrade: true,
    isVisible: true,
    broker: "topstep",
    practice: true,
    autoTrade: { permitted: true },
  };
  return {
    accounts: [prac],
    loadState: "ready" as "idle" | "loading" | "ready" | "failed",
    /** The conflict check's `nonBlocking` answer for the picked account. */
    nonBlocking: [] as Array<{ id: string; name: string | null; strategyKey: string; accountId: number }>,
    /** `GET /api/books`' `accounts` — the server's account-state gates. */
    gates: [] as unknown[],
    /** Resolves the account-status check; replaced to park it. */
    statusAnswer: (): Promise<Response> =>
      Promise.resolve({ ok: true, json: async () => ({}) } as Response),
    reloadAccounts: vi.fn(async () => {}),
    addDeployment: vi.fn(),
    deleteDeployment: vi.fn(),
    syncEngine: vi.fn(),
    confirm: vi.fn(),
    noBroker: false,
  };
});

vi.mock("@/lib/hooks/use-strategies", () => ({
  useDeployments: () => ({
    addDeployment: harness.addDeployment,
    deleteDeployment: harness.deleteDeployment,
  }),
  useDeploymentsLoadState: (): DeploymentsLoadState => harness.loadState,
  loadDeployments: () => [],
  syncEngine: (...args: unknown[]) => harness.syncEngine(...args),
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({
    accounts: harness.accounts,
    visibleAccounts: harness.accounts,
    practiceOnly: true,
    token: "t",
    reloadAccounts: harness.reloadAccounts,
    noBroker: harness.noBroker,
  }),
}));

vi.mock("@/lib/trading/activation-prompts", () => ({
  confirmActivationUnderD2: (...args: unknown[]) => harness.confirm(...args),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  harness.loadState = "ready";
  harness.nonBlocking = [];
  harness.gates = [];
  harness.statusAnswer = () => Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  harness.reloadAccounts.mockClear();
  harness.addDeployment.mockReset();
  harness.deleteDeployment.mockReset();
  harness.syncEngine.mockReset();
  harness.confirm.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/accounts/status") return harness.statusAnswer();
      const body = url.startsWith("/api/books")
        ? { books: [], accounts: harness.gates }
        : url === "/api/deployments/move-account"
          ? { moved: { legs: [], bookId: null } }
          : { blocking: [], nonBlocking: harness.nonBlocking };
      return { ok: true, json: async () => body } as Response;
    }),
  );
});

function fetchCalls(url: string): Array<[string, RequestInit | undefined]> {
  return (vi.mocked(fetch).mock.calls as Array<[string, RequestInit | undefined]>).filter(
    ([u]) => u === url,
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function render(el: ReactElement): HTMLDivElement {
  act(() => root!.render(el));
  return container!;
}

/** An `/api/accounts` row, its verdict the server's (bugs.md A38). */
function account(id: number, name: string, practice: boolean): AccountRow {
  return {
    id,
    name,
    balance: 0,
    canTrade: true,
    isVisible: true,
    broker: "topstep",
    practice,
    autoTrade: autoTradeVerdict({ name, broker: "topstep", practice }),
  };
}

describe("the header's Deploy button", () => {
  it("is disabled with the reason in its title when no instrument is declared", () => {
    const el = render(
      <PlaybookDeployButton
        target={{ kind: "inert", reason: NO_CALIBRATED_INSTRUMENT_REASON }}
        open={false}
        onOpen={() => {}}
      />,
    );
    const button = el.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(NO_CALIBRATED_INSTRUMENT_REASON);
  });

  it("with no broker, is disabled — not hidden — with the no-broker sentence beside it and in its title", () => {
    harness.noBroker = true;
    onTestFinished(() => {
      harness.noBroker = false;
    });
    const opened: string[] = [];
    const el = render(
      <PlaybookDeployButton
        target={{ kind: "ready", ticker: "/MNQ" }}
        open={false}
        onOpen={() => opened.push("open")}
      />,
    );
    const button = el.querySelector("button")!;
    expect(button.textContent).toBe("Deploy");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(NO_BROKER_COPY);
    expect(el.textContent).toContain(NO_BROKER_COPY);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/settings");
  });
});

describe("the account list", () => {
  it("renders a funded account refused, with the block's sentence, rather than hiding it", () => {
    const rows = buildDeployAccountRows([
      account(1, "PRAC-V2-100200-90012114", true),
      account(2, "TSTX-441122", false),
    ]);
    const el = render(
      <PlaybookDeployAccounts rows={rows} selected={null} onSelect={() => {}} empty="none" />,
    );
    const radio = el.querySelector<HTMLInputElement>('input[aria-label="TSTX-441122"]');
    expect(radio).not.toBeNull();
    expect(radio!.disabled).toBe(true);
    const row = radio!.closest("tr")!;
    expect(row.title).toBe(LIVE_ACCOUNT_REFUSAL);
    expect(row.textContent).toContain("no auto-trade");

    const practice = el.querySelector<HTMLInputElement>('input[aria-label="PRAC-V2-100200-90012114"]');
    expect(practice!.disabled).toBe(false);
  });

  it("names each radio by its alias while IDs are hidden, and by its account with the switch off", () => {
    const catalogue = [account(1, "PRAC-V2-100200-90012114", true), account(2, "TSTX-441122", false)];
    const saved = harness.accounts;
    harness.accounts = catalogue as typeof harness.accounts;
    onTestFinished(() => {
      harness.accounts = saved;
      localStorage.clear();
    });
    const rows = buildDeployAccountRows(catalogue);
    const list = () => (
      <PrivacyProvider>
        <PlaybookDeployAccounts rows={rows} selected={null} onSelect={() => {}} empty="none" />
      </PrivacyProvider>
    );
    const labels = (el: HTMLElement) =>
      [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.getAttribute("aria-label"));

    expect(labels(render(list()))).toEqual(["PRAC-V2-100200-90012114", "TSTX-441122"]);

    act(() => root!.unmount());
    root = createRoot(container!);
    localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    const el = render(list());
    expect(labels(el)).toEqual(["Account 1", "Account 2"]);
    expect(el.textContent).not.toContain("PRAC-V2-100200-90012114");
    expect(el.textContent).not.toContain("TSTX-441122");
  });
});

// ── The panel's press ──────────────────────────────────────────────────

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => {});
}

async function mountPanelWithAccountPicked(): Promise<HTMLDivElement> {
  const el = render(
    <PlaybookDeployPanel
      playbookKey="orb"
      playbookName="Opening Range Breakout"
      module={{
        config: { name: "Opening Range Breakout", calibratedFor: "MNQ" } as StrategyConfig,
        params: {},
        isTest: false,
      }}
      target={{ kind: "ready", ticker: "/MNQ" }}
      sessionLabel="09:30–16:00"
      isTest={false}
      onClose={() => {}}
    />,
  );
  const radio = el.querySelector<HTMLInputElement>('input[aria-label="PRAC-V2-100200-90012114"]')!;
  act(() => radio.click());
  await settle();
  return el;
}

function deployButton(el: HTMLElement): HTMLButtonElement {
  const buttons = [...el.querySelectorAll("button")].filter((b) => /Deploy/.test(b.textContent ?? ""));
  return buttons[buttons.length - 1];
}

function failureText(el: HTMLElement): string {
  return [...el.querySelectorAll("p")].map((p) => p.textContent ?? "").join("\n");
}

describe("another playbook already on this account and contract", () => {
  const neighbour = {
    id: "leg-capped",
    name: null,
    strategyKey: "orb-sample-capped",
    accountId: 1,
  };

  it("shows the same-contract warning and leaves Deploy pressable", async () => {
    harness.nonBlocking = [neighbour];
    harness.confirm.mockResolvedValue(false);
    const el = await mountPanelWithAccountPicked();
    const warning = sameContractWarning({ ticker: "/MNQ", accountId: 1, others: [neighbour] })!;
    expect(failureText(el)).toContain(warning);

    const button = deployButton(el);
    expect(button.disabled).toBe(false);
    act(() => button.click());
    await settle();
    // The press reached the activation prompts: nothing between the warning
    // and the write refused it.
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  it("shows no warning when nothing else runs on the contract", async () => {
    const el = await mountPanelWithAccountPicked();
    expect(failureText(el)).not.toContain("over the same hours");
    expect(deployButton(el).disabled).toBe(false);
  });
});

describe("a press before the deployment list has loaded", () => {
  it("cannot be made: Deploy reads inert with the loading sentence", async () => {
    harness.loadState = "loading";
    const el = await mountPanelWithAccountPicked();
    const button = deployButton(el);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(DEPLOY_LIST_LOADING);
  });
});

describe("a double press", () => {
  it("opens one prompt sequence, not two", async () => {
    let answer: (v: boolean) => void = () => {};
    harness.confirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    const el = await mountPanelWithAccountPicked();
    act(() => deployButton(el).click());
    act(() => deployButton(el).click());
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    await act(async () => answer(false));
    await settle();
    expect(harness.addDeployment).not.toHaveBeenCalled();
    expect(deployButton(el).disabled).toBe(false);
  });
});

describe("an engine start that fails after the create", () => {
  beforeEach(() => {
    harness.confirm.mockResolvedValue(true);
    harness.addDeployment.mockResolvedValue({ id: "new-leg" });
    harness.syncEngine.mockResolvedValue({ ok: false, error: "boom" });
  });

  it("says the row is still Active when the rollback did not land", async () => {
    harness.deleteDeployment.mockResolvedValue(false);
    const el = await mountPanelWithAccountPicked();
    act(() => deployButton(el).click());
    await settle();
    expect(harness.deleteDeployment).toHaveBeenCalledWith("new-leg");
    const text = failureText(el);
    expect(text).toContain("Engine start failed: boom");
    expect(text).toContain(DEPLOY_ROLLBACK_FAILED);
  });

  it("treats a rollback that threw as one that did not land", async () => {
    harness.deleteDeployment.mockRejectedValue(new TypeError("Failed to fetch"));
    const el = await mountPanelWithAccountPicked();
    act(() => deployButton(el).click());
    await settle();
    expect(failureText(el)).toContain(DEPLOY_ROLLBACK_FAILED);
  });

  it("says the row was deleted when the rollback landed", async () => {
    harness.deleteDeployment.mockResolvedValue(true);
    const el = await mountPanelWithAccountPicked();
    act(() => deployButton(el).click());
    await settle();
    const text = failureText(el);
    expect(text).toContain(DEPLOY_ROLLED_BACK);
    expect(text).not.toContain(DEPLOY_ROLLBACK_FAILED);
  });
});

// ── The account-state gate ─────────────────────────────────────────────

function gate(
  refusal: { kind: string; stamp: string; reason: string } | null,
  over: Record<string, unknown> = {},
) {
  return { accountId: 1, name: "PRAC-V2-100200-90012114", refusal, warning: null, replacements: [], ...over };
}

async function mountPanel(): Promise<HTMLDivElement> {
  const el = render(
    <PlaybookDeployPanel
      playbookKey="orb"
      playbookName="Opening Range Breakout"
      module={{
        config: { name: "Opening Range Breakout", calibratedFor: "MNQ" } as StrategyConfig,
        params: {},
        isTest: false,
      }}
      target={{ kind: "ready", ticker: "/MNQ" }}
      sessionLabel="09:30–16:00"
      isTest={false}
      onClose={() => {}}
    />,
  );
  await settle();
  return el;
}

describe("opening the picker", () => {
  it("runs one account-status check, then re-reads the accounts and the books", async () => {
    const el = await mountPanel();
    // A re-render — picking an account — does not ask again.
    act(() => el.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await settle();

    expect(fetchCalls("/api/accounts/status")).toHaveLength(1);
    expect(fetchCalls("/api/accounts/status")[0]?.[1]?.method).toBe("POST");
    expect(harness.reloadAccounts).toHaveBeenCalledTimes(1);
    expect(fetchCalls("/api/books")).toHaveLength(2);
  });

  it("keeps Deploy inert until the check has answered", async () => {
    let answer: () => void = () => {};
    harness.statusAnswer = () =>
      new Promise<Response>((r) => (answer = () => r({ ok: true, json: async () => ({}) } as Response)));
    const el = await mountPanelWithAccountPicked();
    expect(deployButton(el).disabled).toBe(true);
    expect(deployButton(el).title).toBe(DEPLOY_CHECKING_ACCOUNTS);

    await act(async () => answer());
    await settle();
    expect(deployButton(el).disabled).toBe(false);
  });
});

describe.each([
  { kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL },
  { kind: "locked", stamp: "Locked", reason: lockedRefusal("Daily Loss Limit", null) },
  { kind: "oco-off", stamp: "OCO Off", reason: AUTO_OCO_OFF_REFUSAL },
  { kind: "oco-unknown", stamp: "OCO Unknown", reason: AUTO_OCO_UNKNOWN_REFUSAL },
  { kind: "locked", stamp: "DLL", reason: lockedRefusal("daily loss limit reached", null) },
  { kind: "locked", stamp: "Profit Target", reason: lockedRefusal("daily profit target reached", null) },
  { kind: "dead", stamp: "Max Loss", reason: "This account can no longer trade (maximum loss limit reached)." },
])("an account the state gate refuses as $kind, stamped $stamp", (refusal) => {
  it("is greyed in the picker with its stamp and the server's sentence, and cannot be deployed on", async () => {
    harness.gates = [gate(refusal)];
    const el = await mountPanel();
    const radio = el.querySelector<HTMLInputElement>('input[aria-label="PRAC-V2-100200-90012114"]')!;
    expect(radio.disabled).toBe(true);
    const row = radio.closest("tr")!;
    expect(row.title).toBe(refusal.reason);
    expect(row.textContent).toContain(refusal.stamp);
    const stamp = Array.from(row.querySelectorAll("span")).find((s) => s.textContent === refusal.stamp);
    expect(stamp?.className.split(/\s+/)).not.toContain("uppercase");
    expect(stamp?.className.split(/\s+/)).toContain("text-[var(--danger)]");
    expect(row.textContent).not.toContain("no auto-trade");
    expect(deployButton(el).disabled).toBe(true);
  });
});

describe("Topstep's auto bracket on the chosen account", () => {
  it("is said beside Deploy and blocks nothing", async () => {
    const warning = autoBracketWarning(300, 600);
    harness.gates = [gate(null, { warning })];
    harness.confirm.mockResolvedValue(false);
    const el = await mountPanelWithAccountPicked();
    expect(failureText(el)).toContain(warning);
    const button = deployButton(el);
    expect(button.disabled).toBe(false);
    act(() => button.click());
    await settle();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });
});

describe("Move to replacement", () => {
  function moveButton(el: HTMLElement): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(MOVE_TO_REPLACEMENT_LABEL),
    );
  }

  it("is offered on a dead account with a replacement, and moves only when pressed", async () => {
    harness.gates = [
      gate(
        { kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL },
        { replacements: [{ accountId: 7, name: "PRAC-V2-100200-77777777" }] },
      ),
    ];
    const el = await mountPanel();
    const button = moveButton(el)!;
    expect(button.textContent).toContain("PRAC-V2-100200-77777777");
    expect(fetchCalls("/api/deployments/move-account")).toHaveLength(0);

    act(() => button.click());
    await settle();
    const calls = fetchCalls("/api/deployments/move-account");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ fromAccountId: 1, toAccountId: 7 });
    // The list is read again after the move; the status check is not repeated.
    expect(fetchCalls("/api/accounts/status")).toHaveLength(1);
    expect(fetchCalls("/api/books")).toHaveLength(3);
  });

  it("makes the operator pick when there are several candidates", async () => {
    harness.gates = [
      gate(
        { kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL },
        {
          replacements: [
            { accountId: 7, name: "PRAC-A" },
            { accountId: 8, name: "PRAC-B" },
          ],
        },
      ),
    ];
    const el = await mountPanel();
    expect(moveButton(el)!.disabled).toBe(true);
    const select = el.querySelector<HTMLSelectElement>('select[aria-label="Replacement account"]')!;
    act(() => {
      select.value = "8";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => moveButton(el)!.click());
    await settle();
    const calls = fetchCalls("/api/deployments/move-account");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ fromAccountId: 1, toAccountId: 8 });
  });

  it("is not offered on a dead account with no replacement", async () => {
    harness.gates = [gate({ kind: "dead", stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL })];
    const el = await mountPanel();
    expect(moveButton(el)).toBeUndefined();
  });
});

describe("a network failure after the create", () => {
  it("does not claim nothing was created", async () => {
    harness.confirm.mockResolvedValue(true);
    harness.addDeployment.mockResolvedValue({ id: "new-leg" });
    harness.syncEngine.mockRejectedValue(new TypeError("Failed to fetch"));
    harness.deleteDeployment.mockResolvedValue(true);
    const el = await mountPanelWithAccountPicked();
    act(() => deployButton(el).click());
    await settle();
    const text = failureText(el);
    expect(text).not.toContain(DEPLOY_UNREACHABLE);
    expect(text).toContain(DEPLOY_INTERRUPTED);
    expect(text).toContain(DEPLOY_ROLLED_BACK);
  });
});
