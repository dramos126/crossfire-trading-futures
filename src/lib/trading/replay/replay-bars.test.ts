import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IndicatorConfig } from "@/lib/trading/domain";
import { MIN_WARMUP_BARS } from "@/lib/trading/strategy-types";

const { retrieveBars } = vi.hoisted(() => ({
  retrieveBars: vi.fn<(args: { startTime: string; endTime: string }) => Promise<never[]>>(async () => []),
}));

vi.mock("@/lib/market-data/registry-singleton", () => ({
  marketDataRegistry: { historical: () => ({ retrieveBars }) },
}));

import { computeWarmupBars, fetchReplayBars, POST_EXIT_BARS } from "./replay-bars";

const MACD_SLOW = 200;
const VOLUME_LOOKBACK = 400;
const WARMUP_PAD_BARS = 50;

const macd: IndicatorConfig = { id: "macd", type: "MACD", params: { fast: 12, slow: MACD_SLOW, signal: 9 } };

describe("computeWarmupBars — replay/snapshot warmup under-fetches for MACD and ignores filters", () => {
  it("reads MACD's `slow` as its lookback, as the backtest does", () => {
    expect(computeWarmupBars([macd], {})).toBe(MACD_SLOW * 2 + WARMUP_PAD_BARS);
  });

  it("widens to an enabled entry filter's warmup", () => {
    const params = { volumeFilterEnabled: true, volumeLookback: VOLUME_LOOKBACK };
    expect(computeWarmupBars([], params)).toBe(VOLUME_LOOKBACK * 2 + WARMUP_PAD_BARS);
  });

  it("ignores a disabled filter's lookback", () => {
    const params = { volumeFilterEnabled: false, volumeLookback: VOLUME_LOOKBACK };
    expect(computeWarmupBars([], params)).toBe(MIN_WARMUP_BARS);
  });
});

// The bug file: replay-cache-invalidation-missing-on-snapshot-tail-widening.
describe("POST_EXIT_BARS — the live fetch's tail matches the at-exit snapshot's", () => {
  it("equals the snapshot's BARS_AFTER_EXIT in engine-bar-fetch.ts", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/trading/engine/realtime/engine-bar-fetch.ts"),
      "utf8",
    );
    const match = /const BARS_AFTER_EXIT = (\w+);/.exec(source);
    expect(match, "BARS_AFTER_EXIT not found in engine-bar-fetch.ts").not.toBeNull();
    const value = match![1];
    // Either the engine imports this constant, or its literal is the same number.
    if (value === "POST_EXIT_BARS") return;
    expect(Number(value)).toBe(POST_EXIT_BARS);
  });

  it("fetches POST_EXIT_BARS bars past the exit", async () => {
    retrieveBars.mockClear();
    const exitTime = "2026-10-20T15:00:00.000Z";
    const fiveMinutesMs = 5 * 60_000;
    await fetchReplayBars({
      contractId: "CON.F.US.MNQ.Z26",
      timeframe: "5m",
      entryTime: "2026-10-20T14:00:00.000Z",
      exitTime,
      warmupBars: 10,
    });
    const { endTime } = retrieveBars.mock.calls[0][0];
    expect(new Date(endTime).getTime() - new Date(exitTime).getTime()).toBe(POST_EXIT_BARS * fiveMinutesMs);
  });
});
