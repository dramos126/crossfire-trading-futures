import { describe, it, expect } from "vitest";

import {
  achievedPct,
  createCpuThrottle,
  createJobClock,
  formatCpuReport,
  throttleSleepMs,
} from "./throttle";

describe("throttleSleepMs", () => {
  it("sleeps until the cumulative duty cycle reaches the target", () => {
    // 1000ms of CPU inside 1000ms of wall is 100%; at a 40% target the run
    // must have burned 2500ms of wall, so it owes 1500ms.
    expect(throttleSleepMs(1_000, 1_000, 40)).toBe(1_500);
  });

  it("is zero when the run is already under target", () => {
    expect(throttleSleepMs(200, 1_000, 40)).toBe(0);
    expect(throttleSleepMs(400, 1_000, 40)).toBe(0);
  });

  it("never throttles at 100, which is the no-cap value", () => {
    expect(throttleSleepMs(10_000, 1_000, 100)).toBe(0);
  });

  it("caps one pause but keeps the debt, so the next call still owes", () => {
    expect(throttleSleepMs(10_000, 1_000, 40)).toBe(2_000);
    // Wall advanced by the capped sleep; the remaining debt is still owed.
    expect(throttleSleepMs(10_000, 3_000, 40)).toBe(2_000);
    expect(throttleSleepMs(10_000, 23_000, 40)).toBe(2_000);
    expect(throttleSleepMs(10_000, 25_000, 40)).toBe(0);
  });

  it("measures from process start, so a window that idled pays for the next one", () => {
    // Fold 1 burned 400ms of CPU over 4000ms of wall — well under target — so
    // fold 2 may run flat out until the cumulative ratio catches up.
    expect(throttleSleepMs(1_400, 4_400, 40)).toBe(0);
  });
});

describe("achievedPct", () => {
  it("is the cumulative duty cycle", () => {
    expect(achievedPct(400, 1_000)).toBe(40);
    expect(achievedPct(0, 1_000)).toBe(0);
  });

  it("is zero rather than Infinity before any wall time has passed", () => {
    expect(achievedPct(10, 0)).toBe(0);
  });
});

describe("formatCpuReport", () => {
  it("is the one line the operator reads instead of ps, workers included", () => {
    expect(formatCpuReport({ targetPct: 100, workers: 6, achievedPct: 540.4 })).toBe(
      "cpu: target 100%, workers 6, achieved 540%",
    );
  });
});

describe("createJobClock", () => {
  it("counts wall time only while a job runs, so idle time between jobs banks no credit", () => {
    const base = { cpu: 0, wall: 0 };
    const clock = createJobClock({ cpuMs: () => base.cpu, wallMs: () => base.wall });
    expect(clock.wallMs()).toBe(0);

    base.wall = 5_000; // idle before the first job: loading and the bars
    clock.jobStarted();
    base.wall = 6_000;
    expect(clock.wallMs()).toBe(1_000);
    clock.jobEnded();

    base.wall = 100_000; // idle while the parent runs its own windows
    expect(clock.wallMs()).toBe(1_000);
    clock.jobStarted();
    base.wall = 100_500;
    base.cpu = 1_500;
    expect(clock.wallMs()).toBe(1_500);
    expect(clock.cpuMs()).toBe(1_500);
  });
});

describe("createCpuThrottle", () => {
  function clock(cpuMs: number, wallMs: number) {
    return { cpuMs: () => cpuMs, wallMs: () => wallMs };
  }

  it("reports the workers forked and the CPU summed over the parent and every worker", () => {
    const throttle = createCpuThrottle(100, clock(1_000, 1_000));
    for (let i = 0; i < 3; i++) throttle.addWorker();
    throttle.addWorkerCpuMs(1_500);
    throttle.addWorkerCpuMs(1_500);
    // 1000ms of the parent's own plus 3000ms from workers, over 1000ms of
    // wall: four cores' worth.
    expect(throttle.report()).toEqual({ targetPct: 100, workers: 3, achievedPct: 400 });
  });

  it("reports one worker — the parent — when nothing forked, and the process alone", () => {
    expect(createCpuThrottle(40, clock(400, 1_000)).report()).toEqual({
      targetPct: 40,
      workers: 1,
      achievedPct: 40,
    });
  });

  it("never sleeps the parent for a worker's CPU — the cap is per process", async () => {
    // The parent is at 40% against a 50% target, so it owes nothing; the
    // worker CPU would put it far over if it were counted.
    const throttle = createCpuThrottle(50, clock(400, 1_000));
    throttle.addWorker();
    throttle.addWorkerCpuMs(10_000);
    let done = false;
    void throttle.onProgress().then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(true);
  });
});
