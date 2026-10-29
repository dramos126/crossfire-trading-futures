// @vitest-environment jsdom
/**
 * *Try settings* on the Playbook page.
 *
 * What only a mounted page can show: that the section is on the page and
 * where, that the date note sits under the date fields, that loading a saved
 * run lands in the controls, and what a pressed Run actually sends. The
 * decisions themselves are pinned in `playbook-try-model.test.ts`; these pin
 * that the page is wired to them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlaybookDetail } from "./playbook-detail";
import { TRY_DATES_NOTE } from "./playbook-try-model";
import type { RunSummary, RunTrades } from "@/lib/trading/backtest-artifacts";
import { RISK_SIZING_NEEDS_FEES } from "@/lib/trading/backtest-sizing-input";
import { REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import type { StrategyModule } from "@/lib/trading/strategy-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAYBOOK = "orb-confluence-capped";

const harness = vi.hoisted(() => ({
  runs: [] as RunSummary[],
  posted: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

vi.mock("@/components/backtest/backtest-trade-chart", () => ({ BacktestTradeChart: () => null }));

vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: (key: string): StrategyModule | undefined =>
    key === "orb-confluence-capped"
      ? ({
          version: "1.1.0",
          config: {
            name: "ORB Confluence — capped",
            description: "",
            timeframe: "5m",
            session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
            entryType: 2,
            indicators: [],
            calibratedFor: "MNQ",
          },
          params: {
            timeframe: {
              type: "select",
              label: "Timeframe",
              default: "5m",
              options: [
                { value: "1m", label: "1 Minute" },
                { value: "5m", label: "5 Minutes" },
              ],
            },
            atrPeriod: { type: "integer", label: "ATR period", default: 14 },
          },
          shouldEnter: () => null,
          shouldExit: () => false,
        } as unknown as StrategyModule)
      : undefined,
}));

vi.mock("@/lib/hooks/use-strategies", () => ({
  useDeployments: () => ({ addDeployment: vi.fn(), deleteDeployment: vi.fn() }),
  useDeploymentsLoadState: () => "ready",
  loadDeployments: () => [],
  syncEngine: vi.fn(),
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ accounts: [], visibleAccounts: [], practiceOnly: true, token: "t" }),
}));

vi.mock("@/lib/trading/activation-prompts", () => ({ confirmActivationUnderD2: vi.fn() }));

vi.mock("@/lib/data/bar-cache-idb", () => ({ getCachedBars: vi.fn(async () => null) }));

const saved: RunSummary = {
  runPath: `${PLAYBOOK}/clamp447-350`,
  label: "clamp447-350",
  playbookKey: PLAYBOOK,
  playbookVersion: "1.0.0",
  ticker: "MNQ",
  timeframe: "1m",
  from: "2024-01-02",
  to: "2024-03-28",
  calibratedFor: "MNQ",
  tickSize: 0.25,
  kind: "run",
  modifiedMs: 1,
  tradeCount: 0,
  resolvedParams: { atrPeriod: 21, size: 2 },
  sizing: { mode: "risk", riskUsd: 350, maxContracts: 100 },
  feePerSide: 0.62,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  harness.runs = [saved];
  harness.posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        harness.posted.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: false, status: 400, body: null, json: async () => ({ error: "stop" }) } as unknown as Response;
      }
      let body: unknown = {};
      if (url === "/api/backtest/runs") body = { runs: harness.runs };
      else if (url.startsWith("/api/backtest/runs/")) body = { summary: saved, trades: [] } satisfies RunTrades;
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

/** Mounts the page with Try settings closed, as every page load leaves it. */
async function mountClosed(): Promise<HTMLElement> {
  act(() => root!.render(<PlaybookDetail playbookKey={PLAYBOOK} onBack={() => {}} />));
  await flush();
  return trySection(container!);
}

async function mount(): Promise<HTMLElement> {
  const section = await mountClosed();
  await click(toggle(section));
  return section;
}

function trySection(el: HTMLElement): HTMLElement {
  const section = [...el.querySelectorAll("section")].find(
    (s) => s.querySelector("h3")?.textContent === "Try settings",
  );
  if (!section) throw new Error("no Try settings section");
  return section;
}

function toggle(section: HTMLElement): HTMLButtonElement {
  const found = section.querySelector<HTMLButtonElement>("header button[aria-expanded]");
  if (!found) throw new Error("no Try settings toggle");
  return found;
}

function body(section: HTMLElement): HTMLElement {
  return document.getElementById(toggle(section).getAttribute("aria-controls")!)!;
}

function byId<T extends HTMLElement>(el: HTMLElement, id: string): T {
  const found = el.querySelector<T>(`#${id}`);
  if (!found) throw new Error(`no #${id}`);
  return found;
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

/** Through the prototype setter, so React's value tracker sees a change. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    set.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function click(target: HTMLElement): Promise<void> {
  act(() => target.click());
  await flush();
}

function radio(el: HTMLElement, label: string): HTMLInputElement {
  const found = [...el.querySelectorAll<HTMLLabelElement>("label")].find(
    (l) => l.textContent?.trim() === label,
  );
  const input = found?.querySelector<HTMLInputElement>('input[type="radio"]');
  if (!input) throw new Error(`no radio "${label}"`);
  return input;
}

describe("Try settings on the Playbook page", () => {
  it("mounts on the page, above Saved Runs", async () => {
    await mount();
    const titles = [...container!.querySelectorAll("section h3")].map((h) => h.textContent);
    expect(titles).toContain("Try settings");
    expect(titles.indexOf("Try settings")).toBeLessThan(titles.indexOf("Saved Runs"));
  });

  it("starts closed on every load, and opens from its header", async () => {
    const section = await mountClosed();
    expect(toggle(section).getAttribute("aria-expanded")).toBe("false");
    expect(body(section).hidden).toBe(true);

    await click(toggle(section));
    expect(toggle(section).getAttribute("aria-expanded")).toBe("true");
    expect(body(section).hidden).toBe(false);
    expect(byId(section, "atrPeriod")).toBeDefined();
  });

  it("keeps the form and a run's result across a close", async () => {
    const runError = (el: HTMLElement) =>
      [...el.querySelectorAll("div")].find((d) => d.textContent === "stop" && d.children.length === 0);
    const section = await mount();
    await type(byId(section, "atrPeriod"), "30");
    expect(runError(section)).toBeUndefined();
    await click(buttonByText(section, "Run"));
    expect(harness.posted).toHaveLength(1);
    expect(runError(section)).toBeDefined();

    await click(toggle(section));
    expect(body(section).hidden).toBe(true);
    await click(toggle(section));
    expect(byId<HTMLInputElement>(section, "atrPeriod").value).toBe("30");
    expect(runError(section)).toBeDefined();
  });

  it("renders the date note under the date fields", async () => {
    const section = await mount();
    const dates = section.querySelector<HTMLElement>('[role="group"][aria-label="Dates"]')!;
    const end = byId<HTMLInputElement>(dates, "try-end-date");
    const note = [...dates.querySelectorAll("p")].find((p) => p.textContent === TRY_DATES_NOTE);
    expect(note).toBeDefined();
    expect(end.compareDocumentPosition(note!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("fills the form from a saved run's header and names the key it left out", async () => {
    const section = await mount();
    await choose(byId<HTMLSelectElement>(section, "try-load-run"), saved.runPath);

    expect(byId<HTMLInputElement>(section, "atrPeriod").value).toBe("21");
    expect(byId<HTMLSelectElement>(section, "timeframe").value).toBe("1m");
    expect(byId<HTMLInputElement>(section, "try-start-date").value).toBe("2024-01-02");
    expect(byId<HTMLInputElement>(section, "try-end-date").value).toBe("2024-03-28");
    expect(radio(section, "Risk per trade").checked).toBe(true);
    expect(byId<HTMLInputElement>(section, "try-risk-usd").value).toBe("350");
    expect(byId<HTMLInputElement>(section, "try-max-contracts").value).toBe("100");
    expect(section.textContent).toContain("Loaded from clamp447-350.");
    expect(section.textContent).toContain("this playbook no longer has this setting: size.");
  });

  it("sends a ceiling above the live one in the backtest body, and says the run is research", async () => {
    const section = await mount();
    await click(radio(section, "Risk per trade"));
    expect(byId<HTMLInputElement>(section, "try-max-contracts").value).toBe(String(REVIEWED_MAX_CONTRACTS));
    await type(byId(section, "try-risk-usd"), "350");
    await type(byId(section, "try-max-contracts"), "10");
    expect(section.textContent).toContain("so this run is research");

    await click(buttonByText(section, "Run"));
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0].url).toBe("/api/backtest");
    expect(harness.posted[0].body.sizing).toEqual({ mode: "risk", maxRiskPerTradeUsd: 350, maxContracts: 10 });
  });

  it("loads a run made on another instrument, and says in warn tone that it will not reproduce", async () => {
    const mes: RunSummary = { ...saved, runPath: `${PLAYBOOK}/mes-probe`, label: "mes-probe", ticker: "MES" };
    harness.runs = [saved, mes];
    const section = await mount();

    await choose(byId<HTMLSelectElement>(section, "try-load-run"), saved.runPath);
    expect(section.textContent).not.toContain("That run traded");

    await choose(byId<HTMLSelectElement>(section, "try-load-run"), mes.runPath);
    expect(byId<HTMLInputElement>(section, "atrPeriod").value).toBe("21");
    const warning = [...section.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("That run traded MES"),
    );
    expect(warning?.textContent).toContain("on MNQ");
    expect(warning?.className).toContain("var(--warning)");
  });

  it("says a fixed count above the live ceiling is research, and not one at it", async () => {
    const section = await mount();
    expect(radio(section, "Fixed contracts").checked).toBe(true);
    await type(byId(section, "try-contracts"), String(REVIEWED_MAX_CONTRACTS));
    expect(section.textContent).not.toContain("so this run is research");
    await type(byId(section, "try-contracts"), String(REVIEWED_MAX_CONTRACTS + 1));
    expect(section.textContent).toContain("so this run is research");
  });

  it("refuses risk sizing with fees off before anything is sent", async () => {
    const section = await mount();
    await click(radio(section, "Risk per trade"));
    await type(byId(section, "try-risk-usd"), "225");
    const fees = [...section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((c) =>
      c.closest("label")?.textContent?.includes("Include fees"),
    )!;
    await click(fees);

    const run = buttonByText(section, "Run");
    expect(run.disabled).toBe(true);
    expect(run.title).toBe(RISK_SIZING_NEEDS_FEES);
    expect(section.textContent).toContain(RISK_SIZING_NEEDS_FEES);
    await click(run);
    expect(harness.posted).toHaveLength(0);
  });
});
