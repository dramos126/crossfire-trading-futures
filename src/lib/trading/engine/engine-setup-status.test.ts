import { describe, it, expect } from "vitest";
import type { SetupReading, StrategyContext, StrategyModule } from "@/lib/trading/strategy-types";
import { LEGACY_DAY_SESSION, withCommonParams } from "@/lib/trading/strategy-types";
import { SetupReadings, readSetupStatus, type SetupReadingsDeps } from "./engine-setup-status";

const LEG = "depl-a";
const OTHER = "depl-b";
const NOTE = "Range 21,410–21,452 set · waiting on a 5m close past either side.";

function moduleWith(setupStatus?: (ctx: StrategyContext) => SetupReading | null): StrategyModule {
  return {
    version: "1.0.0",
    params: withCommonParams({}),
    config: {
      name: "Setup",
      timeframe: "5m",
      session: LEGACY_DAY_SESSION,
      entryType: 2,
      indicators: [],
    },
    shouldEnter: () => null,
    shouldExit: () => false,
    ...(setupStatus ? { setupStatus } : {}),
  };
}

// The hooks under test never read the context; one shape serves every case.
const CTX = {} as StrategyContext;

function harness() {
  const emits: number[] = [];
  const warnings: Array<{ deploymentId: string; message: string }> = [];
  const deps = {
    emitChanged: () => void emits.push(1),
    warnHookFailed: (deploymentId: string, message: string) => void warnings.push({ deploymentId, message }),
  } satisfies SetupReadingsDeps;
  return { readings: new SetupReadings(deps), emits, warnings };
}

/** One bar the engine evaluated to the hook, as `processDeployment` drives it. */
function evaluatedBar(readings: SetupReadings, id: string, strategy: StrategyModule): void {
  readings.beginBar(id);
  readings.offer(id, strategy, CTX);
  readings.settle(id);
}

describe("readSetupStatus", () => {
  it("reads a hook's note", () => {
    expect(readSetupStatus(moduleWith(() => ({ note: NOTE })), CTX)).toEqual({ note: NOTE, error: null });
  });

  it("reads no reading when the hook is absent, answers null, or answers an empty note", () => {
    expect(readSetupStatus(moduleWith(), CTX)).toEqual({ note: null, error: null });
    expect(readSetupStatus(moduleWith(() => null), CTX)).toEqual({ note: null, error: null });
    expect(readSetupStatus(moduleWith(() => ({ note: "  " })), CTX)).toEqual({ note: null, error: null });
  });

  it("reads a throw as no reading, and hands back what it said", () => {
    const throwing = moduleWith(() => {
      throw new Error("bad bars");
    });
    expect(readSetupStatus(throwing, CTX)).toEqual({ note: null, error: "bad bars" });
  });
});

describe("SetupReadings", () => {
  it("publishes the hook's note for a bar that reached it", () => {
    const { readings, emits } = harness();
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: NOTE })));
    expect(readings.snapshot()).toEqual({ [LEG]: NOTE });
    expect(emits).toHaveLength(1);
  });

  it("broadcasts on change only: the same note bar after bar is one frame", () => {
    const { readings, emits } = harness();
    const armed = moduleWith(() => ({ note: NOTE }));
    evaluatedBar(readings, LEG, armed);
    evaluatedBar(readings, LEG, armed);
    evaluatedBar(readings, LEG, armed);
    expect(emits).toHaveLength(1);
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: "First trading day of the month · enters on the 09:30 bar." })));
    expect(emits).toHaveLength(2);
  });

  it("clears the reading on a bar that returned before the hook was asked", () => {
    const { readings, emits } = harness();
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: NOTE })));
    // An early-return gate: the bar began, nothing offered, the bar settled.
    readings.beginBar(LEG);
    readings.settle(LEG);
    expect(readings.snapshot()).toEqual({});
    expect(emits).toHaveLength(2);
  });

  it("leaves the reading alone when no bar was evaluated", () => {
    const { readings, emits } = harness();
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: NOTE })));
    // `processDeployment` skipped an already-processed bar: settle with no bar in flight.
    readings.settle(LEG);
    expect(readings.snapshot()).toEqual({ [LEG]: NOTE });
    expect(emits).toHaveLength(1);
  });

  it("asks nothing outside a bar in flight", () => {
    const { readings, emits } = harness();
    readings.offer(LEG, moduleWith(() => ({ note: NOTE })), CTX);
    readings.settle(LEG);
    expect(readings.snapshot()).toEqual({});
    expect(emits).toHaveLength(0);
  });

  it("reads an absent or null-answering hook as flat", () => {
    const { readings, emits } = harness();
    evaluatedBar(readings, LEG, moduleWith());
    evaluatedBar(readings, OTHER, moduleWith(() => null));
    expect(readings.snapshot()).toEqual({});
    expect(emits).toHaveLength(0);
  });

  it("reads a throwing hook as flat and warns once per leg, not per bar", () => {
    const { readings, warnings } = harness();
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: NOTE })));
    const throwing = moduleWith(() => {
      throw new Error("bad bars");
    });
    evaluatedBar(readings, LEG, throwing);
    evaluatedBar(readings, LEG, throwing);
    expect(readings.snapshot()).toEqual({});
    expect(warnings).toEqual([
      {
        deploymentId: LEG,
        message: "Setup status hook threw (bad bars) — the dashboard shows this leg as flat. Entries are unaffected.",
      },
    ]);
  });

  it("clear drops a leg's reading and a bar in flight", () => {
    const { readings, emits } = harness();
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: NOTE })));
    readings.beginBar(LEG);
    readings.clear(LEG);
    readings.settle(LEG);
    expect(readings.snapshot()).toEqual({});
    expect(emits).toHaveLength(2);
  });

  it("retain keeps the named legs and drops the rest in one frame", () => {
    const { readings, emits } = harness();
    const armed = moduleWith(() => ({ note: NOTE }));
    evaluatedBar(readings, LEG, armed);
    evaluatedBar(readings, OTHER, armed);
    emits.length = 0;
    readings.retain(new Set([LEG]));
    expect(readings.snapshot()).toEqual({ [LEG]: NOTE });
    expect(emits).toHaveLength(1);
    readings.retain(new Set([LEG]));
    expect(emits).toHaveLength(1);
  });

  it("retain drops a dropped leg's bar in flight, so its settle cannot bring the reading back", () => {
    const { readings } = harness();
    const armed = moduleWith(() => ({ note: NOTE }));
    readings.beginBar(OTHER);
    readings.offer(OTHER, armed, {} as never);
    readings.retain(new Set([LEG]));
    readings.settle(OTHER);
    expect(readings.snapshot()).toEqual({});
  });

  it("reset empties the map and says so only if it held something", () => {
    const { readings, emits } = harness();
    readings.reset();
    expect(emits).toHaveLength(0);
    evaluatedBar(readings, LEG, moduleWith(() => ({ note: NOTE })));
    readings.reset();
    expect(readings.snapshot()).toEqual({});
    expect(emits).toHaveLength(2);
  });
});
