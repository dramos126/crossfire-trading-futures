// @vitest-environment jsdom
/**
 * The request a run sends, on the cached-bars path.
 *
 * `/api/backtest/eval` takes a number for `feePerSideUsd` over `includeFees`,
 * so a body that sent the ticker's fee whatever the box said charged fees on a
 * cached run with fees off. The decision sits inside `run`, so the hook is
 * mounted and the body recorded rather than the expression lifted out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useBacktestRunner, type BacktestRunner } from "./use-backtest-runner";
import type { BarCacheEntry } from "@/lib/data/bar-cache-idb";
import { feePerSideFor } from "@/lib/trading/orders/fees";
import type { BacktestSizing } from "@/lib/trading/backtest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  cached: null as BarCacheEntry | null,
  bodies: [] as Array<{ url: string; body: Record<string, unknown> }>,
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ token: "t" }),
}));

vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: () => ({ config: { timeframe: "5m" } }),
}));

vi.mock("@/lib/data/bar-cache-idb", () => ({
  getCachedBars: vi.fn(async () => harness.cached),
}));

const CACHED: BarCacheEntry = {
  key: "k",
  bars: [],
  tickSize: 0.25,
  tickValue: 0.5,
  contractId: "CON.F.US.MNQ.Z25",
  contractName: "MNQZ5",
  cachedAt: 0,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let runner: BacktestRunner | null = null;

function Probe({ sizing }: { sizing?: BacktestSizing }) {
  runner = useBacktestRunner({ strategyKey: "orb", ticker: "/MNQ", params: {}, sizing });
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  harness.bodies = [];
  harness.cached = CACHED;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      harness.bodies.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: false, status: 400, body: null, json: async () => ({ error: "stop" }) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  runner = null;
  vi.unstubAllGlobals();
});

async function mountAndRun(includeFees: boolean, sizing?: BacktestSizing) {
  act(() => root!.render(<Probe sizing={sizing} />));
  act(() => runner!.setIncludeFees(includeFees));
  await act(async () => {
    await runner!.run();
  });
  expect(harness.bodies).toHaveLength(1);
  return harness.bodies[0];
}

describe("useBacktestRunner on the cached-bars path", () => {
  it("charges no fees when fees are off", async () => {
    const sent = await mountAndRun(false);
    expect(sent.url).toBe("/api/backtest/eval");
    expect(sent.body.includeFees).toBe(false);
    expect(sent.body.feePerSideUsd).toBe(0);
  });

  it("charges the instrument's fee when fees are on", async () => {
    const sent = await mountAndRun(true);
    expect(sent.body.feePerSideUsd).toBe(feePerSideFor("/MNQ"));
    expect(feePerSideFor("/MNQ")).toBeGreaterThan(0);
  });

  it("sends the caller's sizing, a ceiling above the live one included", async () => {
    const sizing: BacktestSizing = { mode: "risk", maxRiskPerTradeUsd: 350, maxContracts: 10 };
    const sent = await mountAndRun(true, sizing);
    expect(sent.body.sizing).toEqual(sizing);
  });
});

describe("useBacktestRunner on the fetched-bars path", () => {
  it("sends the fees box and the sizing, and no fee figure of its own", async () => {
    harness.cached = null;
    const sent = await mountAndRun(false, { mode: "fixed", contracts: 2 });
    expect(sent.url).toBe("/api/backtest");
    expect(sent.body).toMatchObject({ includeFees: false, sizing: { mode: "fixed", contracts: 2 } });
    expect(sent.body).not.toHaveProperty("feePerSideUsd");
  });
});

describe("useBacktestRunner's request on either path", () => {
  // Nothing on the page sets or shows a balance, so a hidden one would make
  // the result carry balance figures nobody chose.
  it.each([
    ["cached", CACHED],
    ["fetched", null],
  ])("sends no starting balance on the %s path", async (_path, cached) => {
    harness.cached = cached;
    const sent = await mountAndRun(true);
    expect(sent.body).not.toHaveProperty("startingBalance");
  });
});
