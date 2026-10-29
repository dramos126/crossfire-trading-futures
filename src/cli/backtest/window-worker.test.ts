import { describe, it, expect, vi, beforeEach } from "vitest";

import { CliError } from "./cli-error";
import type { LabelIndex } from "./regime-labels";
import { runWindow } from "./run-window";
import { createCpuThrottle, type ProcessClock } from "./throttle";
import { createWorkerHandler, type WorkerDeps } from "./window-worker";
import type { FromWorker, WindowJob } from "./worker-pool";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { LEGACY_DAY_SESSION, withCommonParams, type StrategyModule } from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";

const FIVE_MINUTES_MS = 5 * 60_000;

const alwaysEnters = {
  key: "always-enters",
  version: "1.0.0",
  config: {
    name: "Always enters",
    description: "fixture",
    timeframe: "5m",
    session: LEGACY_DAY_SESSION,
    entryType: 2,
    indicators: [],
  },
  params: withCommonParams({}),
  shouldEnter: () => ({ side: 0, slTicks: 8, tpTicks: 16 }),
  shouldExit: () => true,
} satisfies StrategyModule;

const BARS: BarData[] = ["2025-06-03", "2025-06-04"].flatMap((date) => {
  const open = new Date(`${date}T13:30:00.000Z`).getTime();
  return Array.from({ length: 12 }, (_, i) => ({
    timestamp: new Date(open + i * FIVE_MINUTES_MS).toISOString(),
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100 + (i % 2),
    volume: 10,
  }));
});

/**
 * A process running flat out: every CPU read is another slice of work, which
 * advances CPU and wall together, and a throttle sleep advances wall alone.
 */
const { simulated, sleeps } = vi.hoisted(() => ({
  simulated: { cpu: 0, wall: 0 },
  sleeps: [] as number[],
}));
const WORK_SLICE_MS = 100;
const IDLE_MS = 1_000_000;

vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    sleeps.push(ms);
    simulated.wall += ms;
  },
}));

const simulatedClock: ProcessClock = {
  cpuMs: () => {
    simulated.cpu += WORK_SLICE_MS;
    simulated.wall += WORK_SLICE_MS;
    return simulated.cpu;
  },
  wallMs: () => simulated.wall,
};

/** Enough bars in one session that the bar loop calls the throttle twice —
 *  it does so every 500 bars. */
const DENSE_BAR_COUNT = 1_100;
const DENSE_BAR_SPACING_MS = 20_000;
const DENSE_BARS: BarData[] = Array.from({ length: DENSE_BAR_COUNT }, (_, i) => ({
  timestamp: new Date(new Date("2025-06-04T13:30:00.000Z").getTime() + i * DENSE_BAR_SPACING_MS).toISOString(),
  open: 100,
  high: 100.5,
  low: 99.5,
  close: 100 + (i % 2),
  volume: 10,
}));

const JOB: WindowJob = {
  from: "2025-06-04",
  to: "2025-06-04",
  warmupDays: 1,
  tickSize: 0.25,
  tickValue: 0.5,
  daySession: CONTRACT_SPECS.MNQ.daySession,
  feePerSideUsd: 0,
  paramOverrides: { timeframe: "5m" },
  sizing: { mode: "fixed", contracts: 1 },
  dailyLossUsd: null,
  dailyProfitUsd: null,
  foldId: 0,
  sample: "test",
  tradeIdStart: 1,
  regimes: null,
};

const FIXED_CLOCK: ProcessClock = { cpuMs: () => 1_234, wallMs: () => 0 };

function harness(
  loadStrategy: WorkerDeps["loadStrategy"] = async () => alwaysEnters,
  clock: ProcessClock = FIXED_CLOCK,
) {
  const sent: FromWorker[] = [];
  let delivered: () => void = () => {};
  const deps = {
    loadStrategy: vi.fn(loadStrategy),
    clock,
    createThrottle: vi.fn((cpuTarget: number, c: ProcessClock) => createCpuThrottle(cpuTarget, c)),
    send: (message: FromWorker) => {
      sent.push(message);
      delivered();
    },
  } satisfies WorkerDeps;
  const next = () =>
    new Promise<FromWorker>((resolve) => {
      delivered = () => resolve(sent[sent.length - 1]);
    });
  return { handle: createWorkerHandler(deps), deps, next };
}

describe("createWorkerHandler", () => {
  beforeEach(() => {
    sleeps.length = 0;
  });

  it("loads the playbook once and answers each job with runWindow's result and its CPU", async () => {
    const { handle, deps, next } = harness();
    handle({ type: "init", playbook: "always-enters", cpuTarget: 60, allBars: BARS, labels: null });

    let reply = next();
    handle({ type: "job", index: 4, job: JOB });
    const first = await reply;
    reply = next();
    handle({ type: "job", index: 5, job: JOB });
    const second = await reply;

    const direct = await runWindow({ ...JOB, strategy: alwaysEnters, allBars: BARS, labels: null });
    expect(first).toEqual({ type: "result", index: 4, result: direct, cpuMs: 1_234 });
    expect(second).toMatchObject({ type: "result", index: 5 });
    expect(direct.records.length).toBeGreaterThan(0);
    expect(deps.loadStrategy).toHaveBeenCalledTimes(1);
    expect(deps.loadStrategy).toHaveBeenCalledWith("always-enters");
    expect(deps.createThrottle).toHaveBeenCalledWith(60, expect.anything());
  });

  it("runs every job against the label index init carried, which no job repeats", async () => {
    const labels: LabelIndex = new Map([
      [
        "2025-06-04",
        {
          label: "active.expanded",
          vol: "active",
          range: "expanded",
          classifierVersion: "1",
          features: { vol5: 1, vol5Pct: 50, rthRange: 1, rangeRatio: 1 },
        },
      ],
    ]);
    const { handle, next } = harness();
    handle({ type: "init", playbook: "always-enters", cpuTarget: 100, allBars: BARS, labels });
    const reply = next();
    handle({ type: "job", index: 0, job: JOB });
    const answer = await reply;

    if (answer.type !== "result") throw new Error("expected a result");
    expect(answer.result.records.length).toBeGreaterThan(0);
    expect(answer.result.records.every((r) => r.regime?.label === "active.expanded")).toBe(true);
  });

  it("sleeps on a job after an idle spell exactly as if the idle time never happened", async () => {
    /** Two jobs at a 50% target, with or without a long idle between them —
     *  the parent running a fold's base and held-out windows. */
    async function secondJobSleeps(idleMs: number): Promise<number[]> {
      sleeps.length = 0;
      const { handle, next } = harness(undefined, simulatedClock);
      simulated.cpu = 0;
      simulated.wall = 0;
      handle({ type: "init", playbook: "always-enters", cpuTarget: 50, allBars: DENSE_BARS, labels: null });
      let reply = next();
      handle({ type: "job", index: 0, job: JOB });
      await reply;
      const firstJobSleeps = sleeps.length;
      simulated.wall += idleMs;
      reply = next();
      handle({ type: "job", index: 1, job: JOB });
      await reply;
      return sleeps.slice(firstJobSleeps);
    }

    const busy = await secondJobSleeps(0);
    const afterIdle = await secondJobSleeps(IDLE_MS);

    expect(busy.length).toBeGreaterThan(0);
    expect(afterIdle).toEqual(busy);
  });

  it("reports a loader refusal on the job as a CliError, not a crash", async () => {
    const { handle, next } = harness(async () => {
      throw new CliError('window worker: unknown playbook "nope"');
    });
    handle({ type: "init", playbook: "nope", cpuTarget: 100, allBars: BARS, labels: null });
    const reply = next();
    handle({ type: "job", index: 0, job: JOB });

    expect(await reply).toEqual({
      type: "failure",
      index: 0,
      message: 'window worker: unknown playbook "nope"',
      stack: null,
      cliError: true,
    });
  });

  it("refuses a job that arrives before init, carrying the message and its stack apart", async () => {
    const { handle, next } = harness();
    const reply = next();
    handle({ type: "job", index: 2, job: JOB });

    const answer = await reply;
    expect(answer).toMatchObject({
      type: "failure",
      index: 2,
      message: "window worker received a job before init",
      cliError: false,
    });
    if (answer.type !== "failure") throw new Error("expected a failure");
    expect(answer.stack).toMatch(/^Error: window worker received a job before init\n\s+at /);
  });
});
