// @vitest-environment jsdom
/**
 * Saved Runs on the Playbook page.
 *
 * What only a mounted page can show: that the reader is scoped to *this*
 * playbook's key — off each run's header, so a folder named after this
 * playbook holding another playbook's run stays off the page — and that the
 * chart's timeframe and whole-day choices outlive a ◀ ▶ step and a change of
 * run, which is state held across a remount of the chart and nowhere below
 * the DOM. The chart is mocked to a prop recorder because lightweight-charts
 * wants a canvas; the panel, the page and the window module are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PlaybookDetail } from "./playbook-detail";
import { SAVED_RUNS_EMPTY } from "@/components/backtest/backtest-run-model";
import { NO_BOOK_STAMP, NO_BOOK_TITLE } from "@/components/playbook/playbook-detail-model";
import type { BacktestTradeChart } from "@/components/backtest/backtest-trade-chart";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { RunSummary, RunTrades } from "@/lib/trading/backtest-artifacts";
import type { StrategyModule } from "@/lib/trading/strategy-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ChartProps = Parameters<typeof BacktestTradeChart>[0];

const PLAYBOOK = "orb-confluence-capped";

const harness = vi.hoisted(() => ({
  chartProps: [] as ChartProps[],
  runs: [] as RunSummary[],
  trades: new Map<string, RunTrades>(),
  requested: [] as string[],
}));

vi.mock("@/components/backtest/backtest-trade-chart", () => ({
  BacktestTradeChart: (props: ChartProps) => {
    harness.chartProps.push(props);
    return null;
  },
}));

vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: (key: string): StrategyModule | undefined =>
    key === "orb-confluence-capped"
      ? ({
          version: "1.0.0",
          config: {
            name: "ORB Confluence — capped",
            description: "",
            timeframe: "5m",
            session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
            entryType: 2,
            indicators: [],
          },
          params: {},
          shouldEnter: () => null,
          shouldExit: () => false,
        } as unknown as StrategyModule)
      : key === "noise-callout"
        ? ({
            version: "1.0.0",
            config: {
              name: "Zeta Breakout 30m — MNQ",
              description: "",
              timeframe: "30m",
              session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
              calibratedFor: "MNQ",
              fixedStopTicks: 1500,
              entryType: 2,
              indicators: [],
            },
            params: {},
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

// Fixture books: `noise-callout` is in one, `orb-confluence-capped` in none,
// whatever the books in code hold today.
vi.mock("@/lib/trading/books/code-books", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/books/code-books")>()),
  CODE_BOOKS: [{ key: "fx", name: "Fixture", cells: [{ ticker: "/MES", strategyKey: "noise-callout" }] }],
}));

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    runPath: "x/y",
    label: "y",
    playbookKey: PLAYBOOK,
    playbookVersion: "1.0.0",
    ticker: "MNQ",
    timeframe: "5m",
    from: "2022-01-01",
    to: "2022-12-31",
    calibratedFor: "MNQ",
    tickSize: 0.25,
    kind: "run",
    modifiedMs: 1,
    tradeCount: 2,
    resolvedParams: null,
    sizing: null,
    feePerSide: null,
    ...overrides,
  };
}

function trade(overrides: Partial<CliTradeRecord>): CliTradeRecord {
  return {
    tradeId: 1,
    foldId: -1,
    sample: "test",
    sessionDate: "2022-07-05",
    regime: null,
    signalBarTs: "2022-07-05T14:05:00.000Z",
    entryTs: "2022-07-05T14:05:00.000Z",
    entryBarIndex: 10,
    side: 0,
    entryPrice: 11540,
    slPrice: 11500,
    tpPrice: 11620,
    slTicks: 160,
    tpTicks: 320,
    contracts: 1,
    exitTs: "2022-07-05T16:25:00.000Z",
    exitBarIndex: 38,
    exitPrice: 11620,
    exitReason: "take_profit",
    pnlTicks: 320,
    pnlGrossDollars: 160,
    feesDollars: 1.24,
    pnlNetDollars: 158.76,
    rMultiple: 2,
    mfeTicks: 340,
    mfeBarIndex: 20,
    maeTicks: 20,
    maeBarIndex: 6,
    barsHeld: 28,
    slMoved: { breakeven: false, trail: false },
    entryMeta: null,
    exitMeta: null,
    entryHourEt: 10,
    weekday: 2,
    ...overrides,
  };
}

/** The derived-view shape on disk under `no-trade-days-*`: a zero-P&L
 *  placeholder, not a trade. */
const placeholder = trade({
  tradeId: 2,
  sessionDate: "2022-07-06",
  entryTs: "2022-07-06T14:30:00.000Z",
  signalBarTs: "2022-07-06T14:30:00.000Z",
  entryBarIndex: -1,
  exitTs: "2022-07-06T19:59:00.000Z",
  exitBarIndex: -1,
  exitPrice: 11540,
  exitReason: "no_trade_day" as CliTradeRecord["exitReason"],
  contracts: 0,
  pnlTicks: 0,
  pnlGrossDollars: 0,
  feesDollars: 0,
  pnlNetDollars: 0,
  rMultiple: 0,
  mfeTicks: 0,
  maeTicks: 0,
  barsHeld: 0,
  entryMeta: { gapDay: "NO TRADE — placeholder, not a trade." },
});

const mine5m = run({ runPath: `${PLAYBOOK}/clamp-5m`, label: "clamp-5m", timeframe: "5m", modifiedMs: 3 });
// Header-keyed to this playbook from another playbook's folder.
const mine15m = run({ runPath: "orb-gaps/gap-15m", label: "gap-15m", timeframe: "15m", modifiedMs: 2 });
// In this playbook's folder, headed for another playbook.
const theirs = run({ runPath: `${PLAYBOOK}/borrowed`, label: "borrowed", playbookKey: "orb", modifiedMs: 4 });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  harness.chartProps = [];
  harness.requested = [];
  harness.runs = [mine5m, mine15m, theirs];
  harness.trades = new Map([
    [mine5m.runPath, { summary: mine5m, trades: [trade({}), placeholder] }],
    [mine15m.runPath, { summary: mine15m, trades: [trade({})] }],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      harness.requested.push(url);
      let body: unknown = {};
      if (url === "/api/backtest/runs") body = { runs: harness.runs };
      else if (url.startsWith("/api/backtest/runs/")) {
        const path = url.slice("/api/backtest/runs/".length).split("/").map(decodeURIComponent).join("/");
        body = harness.trades.get(path);
      }
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

async function mount(): Promise<HTMLDivElement> {
  act(() => root!.render(<PlaybookDetail playbookKey={PLAYBOOK} onBack={() => {}} />));
  await flush();
  return container!;
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function byLabel(el: HTMLElement, label: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no element labelled "${label}"`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  act(() => target.click());
  await flush();
}

const lastChart = () => harness.chartProps[harness.chartProps.length - 1];

describe("Saved Runs on the Playbook page", () => {
  it("lists only the runs whose header names this playbook, whatever folder they sit in", async () => {
    const el = await mount();
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[name="backtest-run"]')];
    const labels = radios.map((r) => r.getAttribute("aria-label") ?? "");
    expect(labels).toHaveLength(2);
    expect(labels.some((l) => l.startsWith("clamp-5m"))).toBe(true);
    expect(labels.some((l) => l.startsWith("gap-15m"))).toBe(true);
    expect(labels.some((l) => l.includes("borrowed"))).toBe(false);
    // The preselected run is this playbook's newest, not the newer foreign one.
    expect(harness.requested).toContain(`/api/backtest/runs/${PLAYBOOK}/clamp-5m`);
    expect(harness.requested.some((u) => u.includes("borrowed"))).toBe(false);
  });

  it("says where runs come from, naming Try settings by its label rather than by position, when this playbook has none", async () => {
    harness.runs = [theirs];
    const el = await mount();
    expect(el.textContent).toContain(SAVED_RUNS_EMPTY);
    expect(SAVED_RUNS_EMPTY).toContain("Try settings");
    expect(el.textContent).not.toContain("panel above");
  });
});

describe("the trade chart's timeframe and whole-day choices", () => {
  it("defaults the picker to the run's own timeframe and the tight window", async () => {
    const el = await mount();
    expect(lastChart().timeframe).toBe("5m");
    expect(lastChart().wholeDay).toBe(false);
    const group = byLabel(el, "Chart timeframe");
    expect(buttonByText(group, "5m").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText(group, "15m").getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps both choices through ◀ ▶, including onto a no-trade-day placeholder", async () => {
    const el = await mount();
    await click(buttonByText(byLabel(el, "Chart timeframe"), "15m"));
    await click(buttonByText(el, "Whole day"));
    expect(lastChart()).toMatchObject({ timeframe: "15m", wholeDay: true });

    await click(byLabel(el, "Next trade"));
    expect(lastChart().marker.entryTime).toBe(placeholder.entryTs);
    expect(lastChart()).toMatchObject({ timeframe: "15m", wholeDay: true });
    expect(el.textContent).toContain("NO TRADE — placeholder, not a trade.");

    await click(byLabel(el, "Previous trade"));
    expect(lastChart().marker.entryTime).toBe(trade({}).entryTs);
    expect(lastChart()).toMatchObject({ timeframe: "15m", wholeDay: true });
  });

  it("follows each run's own timeframe across runs until the operator picks one", async () => {
    const el = await mount();
    const radio = byLabel(el, "gap-15m, MNQ 15m, 2 trades");
    await click(radio);
    expect(lastChart().timeframe).toBe("15m");

    await click(buttonByText(byLabel(el, "Chart timeframe"), "1m"));
    await click(byLabel(el, "clamp-5m, MNQ 5m, 2 trades"));
    expect(lastChart().timeframe).toBe("1m");
  });
});

// Operator decision 2026-10-19 (book-types Q6): an explicit callout on the
// playbook for its minimum risk budget and the shared-account stopgap.
describe("the minimum-risk callout on the Playbook page", () => {
  it("renders under the header, one paragraph per block, for a playbook with a fixed stop", async () => {
    act(() => root!.render(<PlaybookDetail playbookKey="noise-callout" onBack={() => {}} />));
    await flush();
    const callout = container!.querySelector('[data-testid="playbook-minimum-risk"]');
    const paragraphs = [...(callout?.querySelectorAll("p") ?? [])].map((p) => p.textContent ?? "");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain("Needs a risk per trade of at least $752 to take one contract");
    expect(paragraphs[1]).toContain("can only lower that limit, never raise it");
  });

  it("is absent on a playbook that declares no fixed stop", async () => {
    const el = await mount();
    expect(el.querySelector('[data-testid="playbook-minimum-risk"]')).toBeNull();
  });
});

// Operator design request 2026-10-21.
describe("the in-no-book stamp on the Playbook page", () => {
  const stamp = (el: HTMLElement) =>
    [...el.querySelectorAll("span")].find((s) => s.textContent === NO_BOOK_STAMP) ?? null;

  it("stamps a playbook no book carries, titled with what was checked", async () => {
    const el = await mount();
    expect(stamp(el)?.getAttribute("title")).toBe(NO_BOOK_TITLE);
  });

  it("stamps nothing on a playbook a book carries, on a contract other than its own", async () => {
    act(() => root!.render(<PlaybookDetail playbookKey="noise-callout" onBack={() => {}} />));
    await flush();
    expect(stamp(container!)).toBeNull();
  });
});
