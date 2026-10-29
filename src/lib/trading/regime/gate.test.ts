import { describe, it, expect, vi } from "vitest";

import { withRegimeGate } from "./gate";
import {
  LEGACY_DAY_SESSION,
  withCommonParams,
  type CommonParams,
  type StrategyContext,
  type StrategyModule,
} from "@/lib/trading/strategy-types";
import type { BarData } from "@/lib/brokers/types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { collectSessionWindows } from "@/lib/trading/session/session";

const BAR: BarData = {
  timestamp: "2025-06-02T13:30:00.000Z",
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10,
};

function fixture(result: ReturnType<StrategyModule["shouldEnter"]>) {
  return {
    key: "fixture",
    version: "1.0.0",
    config: {
      name: "Fixture",
      timeframe: "5m",
      session: LEGACY_DAY_SESSION,
      entryType: 2,
      indicators: [],
    },
    params: withCommonParams({}),
    shouldEnter: () => result,
    shouldExit: () => false,
  } satisfies StrategyModule;
}

const PARAMS: CommonParams = {
  timeframe: "5m",
  dailyMaxLossUsd: 0,
  dailyMaxProfitUsd: 0,
  dailyPnlIncludeUnrealized: false,
  cooldownSeconds: 0,
  pauseWindows: [],
  playbookMaxContracts: 0,
  playbookRiskPercent: 100,
};

function context(): StrategyContext {
  return {
    bars: [BAR],
    barIndex: 0,
    indicators: new Map(),
    position: null,
    params: PARAMS,
    tickSize: 0.25,
    daySession: CONTRACT_SPECS.MNQ.daySession,
    sessionWindows: collectSessionWindows(LEGACY_DAY_SESSION, PARAMS),
    crossTimeframeBars: new Map(),
    hasEnteredThisSession: () => false,
  } satisfies StrategyContext;
}

describe("withRegimeGate", () => {
  it("passes an entry through on a label in the set", () => {
    const signal = { side: 0 as const, slTicks: 8, tpTicks: 16 };
    const gated = withRegimeGate(fixture(signal), {
      allowed: new Set(["active.expanded"]),
      labelForBar: () => "active.expanded",
    });
    expect(gated.shouldEnter(context())).toBe(signal);
  });

  it("stands the entry down off-label and reports the label that refused it", () => {
    const onSkip = vi.fn();
    const gated = withRegimeGate(fixture({ side: 0, slTicks: 8, tpTicks: 16 }), {
      allowed: new Set(["active.expanded"]),
      labelForBar: () => "quiet.compressed",
      onSkip,
    });
    expect(gated.shouldEnter(context())).toBeNull();
    expect(onSkip).toHaveBeenCalledWith("quiet.compressed", BAR);
  });

  it("stands down on unknown, which is never in the set", () => {
    const gated = withRegimeGate(fixture({ side: 0, slTicks: 8, tpTicks: 16 }), {
      allowed: new Set(["active.expanded", "quiet.compressed"]),
      labelForBar: () => "unknown",
    });
    expect(gated.shouldEnter(context())).toBeNull();
  });

  it("counts nothing when the strategy did not want in", () => {
    const onSkip = vi.fn();
    const gated = withRegimeGate(fixture(null), {
      allowed: new Set(["active.expanded"]),
      labelForBar: () => "quiet.compressed",
      onSkip,
    });
    expect(gated.shouldEnter(context())).toBeNull();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("leaves the strategy's own skip alone rather than restating it as a regime skip", () => {
    const skip = { skip: "narrow range", gate: "orWidth" };
    const onSkip = vi.fn();
    const gated = withRegimeGate(fixture(skip), {
      allowed: new Set(["active.expanded"]),
      labelForBar: () => "quiet.compressed",
      onSkip,
    });
    expect(gated.shouldEnter(context())).toBe(skip);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("keeps every other member of the module, including the exit hook", () => {
    const base = fixture(null);
    const gated = withRegimeGate(base, {
      allowed: new Set(["active.expanded"]),
      labelForBar: () => "active.expanded",
    });
    expect(gated.shouldExit).toBe(base.shouldExit);
    expect(gated.version).toBe("1.0.0");
    expect(gated.params).toBe(base.params);
  });
});
