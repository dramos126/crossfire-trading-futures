// @vitest-environment jsdom
/**
 * The picker's two safety grounds, on the environment that makes an
 * *evaluation* account the interesting row.
 *
 * `deployment-editor.test.tsx` covers this component through the editor, but
 * it pins `prod` — where a Trading Combine is permitted and only a funded
 * name is refused. Staging narrows the rule to practice accounts only, so a
 * `50KTC-` leg an operator created on prod, or before the narrowing, is a
 * refused row that is *already checked*. That is exactly the input the
 * `&& !checked` carve-out exists for, and until this file nothing exercised
 * the picker on the branch where it happens.
 *
 * The component reads the server's verdict off each row (bugs.md A38), so
 * the rows carry what `/api/accounts` would answer under the stubbed
 * environment — the shipped `autoTradeVerdict`, asked at render time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HIDE_ACCOUNT_IDS_KEY } from "@/components/privacy/privacy-model";

// The catalogue the privacy provider numbers; only the display-privacy case
// mounts the provider.
vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ accounts: ACCOUNTS }),
}));

const { AccountLegPicker } = await import("./account-leg-picker");
const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");
import {
  autoTradeVerdict,
  STAGING_PRACTICE_ONLY_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";
import {
  ACCOUNT_DEAD_REFUSAL,
  ACCOUNT_STATE_STAMP,
} from "@/lib/trading/broker-access/account-state-gate";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import type { Account } from "@/lib/brokers/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Real Topstep names, quoted from the confirmed prefix table in
 * docs/modules/brokers/topstep.md. `practice` is the column the translator
 * stamps, not a re-reading of the name.
 */
const PRAC: Account = {
  id: 1,
  name: "PRAC-V2-100200-90012114",
  broker: "topstep",
  practice: true,
} as Account;
const COMBINE: Account = {
  id: 2,
  name: "50KTC-V2-100200-90020038",
  broker: "topstep",
  practice: false,
} as Account;

const ACCOUNTS = [PRAC, COMBINE];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const changes: Array<number[]> = [];
const singles: Array<number | ""> = [];

function picker(props: {
  accountIds: number[];
  isEditMode?: boolean;
  existingLegAccountIds?: number[];
  gates?: AccountGateWire[] | null;
}): ReactElement {
  return (
    <AccountLegPicker
      accounts={ACCOUNTS.map((a) => ({ ...a, autoTrade: autoTradeVerdict(a) }))}
      accountIds={new Set(props.accountIds)}
      onAccountIdsChange={(next) => changes.push([...next])}
      onAccountChange={(id) => singles.push(id)}
      isEditMode={props.isEditMode ?? false}
      existingLegAccountIds={
        props.existingLegAccountIds ? new Set(props.existingLegAccountIds) : undefined
      }
      gates={props.gates}
    />
  );
}

/** The server's gate for {@link COMBINE}, as `GET /api/books` carries it. */
function deadGate(): AccountGateWire {
  return {
    accountId: COMBINE.id,
    name: COMBINE.name,
    refusal: { kind: "dead", stamp: ACCOUNT_STATE_STAMP.dead, reason: ACCOUNT_DEAD_REFUSAL },
    warning: null,
    replacements: [],
  };
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

function rowFor(account: Account): HTMLLabelElement {
  const labels = Array.from(container!.querySelectorAll("label"));
  return labels.find((l) => l.textContent?.includes(account.name)) as HTMLLabelElement;
}

/** The classes on the row's stamp that reads exactly `text`. */
function stampClasses(account: Account, text: string): string[] {
  const span = Array.from(rowFor(account).querySelectorAll("span")).find((s) => s.textContent === text);
  if (!span) throw new Error(`no stamp reading ${text}`);
  return span.className.split(/\s+/);
}

function boxFor(account: Account): HTMLInputElement {
  return rowFor(account).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
}

beforeEach(() => {
  changes.length = 0;
  singles.length = 0;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllEnvs();
});

describe("AccountLegPicker — an evaluation account on staging", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  });

  it("blocks an unchecked Combine and says it is the staging rule", async () => {
    await mount(picker({ accountIds: [PRAC.id] }));

    const box = boxFor(COMBINE);
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    // Verbatim, per ui/copy.md: no surface rewords a refusal, and this one
    // must not read as "your Combine is a live account".
    expect(rowFor(COMBINE).title).toBe(STAGING_PRACTICE_ONLY_REFUSAL);
    expect(rowFor(COMBINE).textContent).toContain("no auto-trade");
    // `no auto-trade` keeps its upper-casing class; the state gate's do not.
    expect(stampClasses(COMBINE, "no auto-trade")).toContain("uppercase");
    // The permitted row is the control: a blanket disable would look
    // identical from the assertion above alone.
    expect(boxFor(PRAC).disabled).toBe(false);
  });

  it("keeps a checked Combine leg removable, which is the `&& !checked` carve-out", async () => {
    // Two legs, so the last-leg pin is not what is being observed. Unchecking
    // *is* remove-leg: a block that disabled a checked row would strand a leg
    // the operator created on prod, with the refusal itself as the hazard.
    await mount(
      picker({
        accountIds: [PRAC.id, COMBINE.id],
        isEditMode: true,
        existingLegAccountIds: [PRAC.id, COMBINE.id],
      }),
    );

    const box = boxFor(COMBINE);
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    // The stamp still renders on the removable row, so it says why it is
    // off-limits without trapping it.
    expect(rowFor(COMBINE).textContent).toContain("no auto-trade");

    await click(box);
    expect(changes).toEqual([[PRAC.id]]);
    expect(singles).toEqual([PRAC.id]);
  });
});

describe("AccountLegPicker — the same account on prod", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  });

  it("offers the Combine as an addable leg", async () => {
    // The control for both cases above: the row is refused by the env branch
    // of the shipped predicate, not by anything about the name. Without this,
    // a picker that refused every `50KTC-` row everywhere would pass.
    await mount(picker({ accountIds: [PRAC.id] }));

    const box = boxFor(COMBINE);
    expect(box.disabled).toBe(false);
    expect(rowFor(COMBINE).textContent).not.toContain("no auto-trade");

    await click(box);
    expect(changes).toEqual([[PRAC.id, COMBINE.id]]);
  });
});

describe("AccountLegPicker — the account-state gate", () => {
  beforeEach(() => {
    // The live-account block permits both here, so the gate is what refuses.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  });

  it("greys an account the server's gate refuses, with the gate's stamp and sentence", async () => {
    await mount(picker({ accountIds: [PRAC.id], gates: [deadGate()] }));

    const box = boxFor(COMBINE);
    expect(box.disabled).toBe(true);
    expect(rowFor(COMBINE).title).toBe(ACCOUNT_DEAD_REFUSAL);
    expect(rowFor(COMBINE).textContent).toContain(ACCOUNT_STATE_STAMP.dead);
    expect(stampClasses(COMBINE, ACCOUNT_STATE_STAMP.dead)).not.toContain("uppercase");
    expect(stampClasses(COMBINE, ACCOUNT_STATE_STAMP.dead)).toContain("text-[var(--danger)]");
    expect(boxFor(PRAC).disabled).toBe(false);
  });

  it("keeps a checked leg on a refused account removable", async () => {
    await mount(
      picker({
        accountIds: [PRAC.id, COMBINE.id],
        isEditMode: true,
        existingLegAccountIds: [PRAC.id, COMBINE.id],
        gates: [deadGate()],
      }),
    );

    const box = boxFor(COMBINE);
    expect(box.disabled).toBe(false);
    expect(rowFor(COMBINE).textContent).toContain(ACCOUNT_STATE_STAMP.dead);
    await click(box);
    expect(changes).toEqual([[PRAC.id]]);
  });

  it("refuses nothing on that ground before the gates are read", async () => {
    await mount(picker({ accountIds: [PRAC.id], gates: null }));
    expect(boxFor(COMBINE).disabled).toBe(false);
  });
});

describe("AccountLegPicker — display privacy", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    localStorage.clear();
  });

  const names = () =>
    Array.from(container!.querySelectorAll("label span.font-mono.flex-1")).map((s) => s.textContent);

  it("names each row by its alias while IDs are hidden", async () => {
    localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    await mount(<PrivacyProvider>{picker({ accountIds: [PRAC.id] })}</PrivacyProvider>);
    expect(names()).toEqual(["Account 1", "Account 2"]);
    expect(container!.textContent).not.toContain(PRAC.name);
    expect(container!.textContent).not.toContain(COMBINE.name);
  });

  it("names each row by its account with the switch off", async () => {
    await mount(<PrivacyProvider>{picker({ accountIds: [PRAC.id] })}</PrivacyProvider>);
    expect(names()).toEqual([PRAC.name, COMBINE.name]);
  });
});
