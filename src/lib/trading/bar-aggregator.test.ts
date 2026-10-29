/**
 * `BarAggregator` — folding trade ticks into closed bars.
 *
 * The property this file exists for: **every bar the aggregator publishes is
 * a bucket that actually traded.** The handler wired here is the same one the
 * market hub gives it, and that handler is the only route from a tick to
 * `processDeployment(strategy, deployment, triggerBar)` and from there to
 * `shouldEnter`. So "nothing manufactured is published" and "nothing
 * manufactured reaches `shouldEnter`" are the same statement — there is no
 * other producer of a `triggerBar`.
 *
 * Assertions are written against published bars, never against the private
 * `hasTrade` flag, so the mechanism can change without rewriting them.
 *
 * One clock throughout, and trade timestamps are taken from it: the grace
 * timer schedules off `Date.now()` while bucketing reads the trade's own
 * timestamp, so a test that lets the two drift schedules its fires somewhere
 * the advance never reaches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { BarData } from "@/lib/brokers/types";
import { BarAggregator } from "./bar-aggregator";

const BUCKET_MS = 60_000;
const T0 = new Date("2026-05-15T14:00:00.000Z").getTime();

/** Open time of the nth 1m bucket after T0. */
function bucket(n: number): number {
  return T0 + BUCKET_MS * n;
}

/** Advance the one clock to an absolute instant, draining timers on the way.
 *  The grace timer for bucket n fires at `bucket(n + 1) + 1500`. */
async function at(ms: number): Promise<void> {
  const delta = ms - Date.now();
  if (delta > 0) await vi.advanceTimersByTimeAsync(delta);
}

interface Wired {
  agg: BarAggregator;
  published: BarData[];
  trade: (price: number, volume: number) => void;
}

function wire(): Wired {
  const published: BarData[] = [];
  const agg = new BarAggregator("1m");
  agg.onBarClose((bar) => published.push(bar));
  return {
    agg,
    published,
    trade: (price, volume) => agg.addTrade(price, volume, Date.now()),
  };
}

describe("BarAggregator — only buckets that traded are published", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes a bucket that traded", async () => {
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);

    await at(bucket(1) + 2_000);

    expect(published).toHaveLength(1);
    expect(published[0].timestamp).toBe(new Date(bucket(0)).toISOString());
    expect(published[0].volume).toBe(5);
  });

  it("publishes a bucket whose trades all landed early in it", async () => {
    // The grace timer's original job, and it survives: a bar that printed at
    // the open and nothing after must still close, or a low-volume contract
    // stalls the strategy.
    const { published, trade } = wire();
    await at(bucket(0) + 500);
    trade(21000, 3);

    await at(bucket(1) + 2_000);

    expect(published).toHaveLength(1);
  });

  it("publishes NOTHING for buckets in which no trade printed", async () => {
    // The defect this pins: the grace timer re-seeds the next bucket from the
    // last seen price, so through a silence the aggregator was manufacturing a
    // flat zero-volume bar per bucket and handing each one to the engine as a
    // `triggerBar`. A strategy could then enter on a bar that never traded.
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);

    await at(bucket(6) + 2_000);

    expect(published).toHaveLength(1);
    expect(published[0].timestamp).toBe(new Date(bucket(0)).toISOString());
  });

  it("publishes no bar at all through a silence that follows a published bucket", async () => {
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);
    await at(bucket(1) + 2_000);
    published.length = 0;

    await at(bucket(11) + 2_000);

    expect(published).toEqual([]);
  });

  it("gives every published bar a volume it was handed, never a fabricated zero", async () => {
    // The property stated over the whole stream rather than per case: a bar
    // the aggregator invented has no trades in it, and one that has trades in
    // it was not invented.
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 4);
    await at(bucket(5) + 2_000);
    trade(21010, 7);

    await at(bucket(6) + 2_000);

    expect(published).toHaveLength(2);
    for (const bar of published) expect(bar.volume).toBeGreaterThan(0);
  });

  it("resumes publishing on the first bucket that trades after a silence", async () => {
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);
    await at(bucket(5) + 2_000);
    published.length = 0;

    trade(21025, 2);
    await at(bucket(6) + 2_000);

    expect(published).toHaveLength(1);
    expect(published[0].timestamp).toBe(new Date(bucket(5)).toISOString());
    expect(published[0].close).toBe(21025);
  });

  it("does not re-publish an already-published bucket when trading resumes", async () => {
    // The re-seed chain has to keep running through the silence: `current` is
    // what the next real trade compares its bucket against, and a `current`
    // parked on an already-published bar would publish that bar a second time.
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);
    await at(bucket(4) + 2_000);
    trade(21030, 1);
    await at(bucket(5) + 2_000);

    const timestamps = published.map((b) => b.timestamp);
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  it("keeps the seeded open price when a trade arrives into a quiet bucket", async () => {
    // The seed's actual purpose, which is preserved: continuity, so a
    // contract that goes quiet does not gap on its next real trade. The bar
    // opens at the prior close and is published because it traded.
    const { published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);
    await at(bucket(1) + 2_000);
    published.length = 0;

    await at(bucket(1) + 30_000);
    trade(21040, 2);
    await at(bucket(2) + 2_000);

    expect(published).toHaveLength(1);
    expect(published[0].open).toBe(21000);
    expect(published[0].close).toBe(21040);
    expect(published[0].high).toBe(21040);
    expect(published[0].volume).toBe(2);
  });

  it("publishes one close across skipped buckets, not one per bucket", async () => {
    // Pre-existing behaviour, restated here because the silence change sits
    // next to it: intermediate empty buckets carry no information.
    const { agg, published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);
    agg.addTrade(21050, 5, bucket(3) + 1_000);

    expect(published).toHaveLength(1);
    expect(published[0].timestamp).toBe(new Date(bucket(0)).toISOString());
  });

  it("stops its timer on dispose so a silent contract leaves nothing behind", async () => {
    const { agg, published, trade } = wire();
    await at(bucket(0) + 1_000);
    trade(21000, 5);
    agg.dispose();

    await at(bucket(5) + 2_000);

    expect(published).toEqual([]);
  });
});

describe("BarAggregator — each close carries the bar it published before (A97)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function wireWithPrevious(): { agg: BarAggregator; previous: Array<string | null>; trade: (p: number) => void } {
    const previous: Array<string | null> = [];
    const agg = new BarAggregator("1m");
    agg.onBarClose((_bar, previousPublishedAt) => previous.push(previousPublishedAt));
    return { agg, previous, trade: (p) => agg.addTrade(p, 1, Date.now()) };
  }

  it("A97: the first close carries null, and each later one the open of the close before it", async () => {
    const { previous, trade } = wireWithPrevious();
    await at(bucket(0) + 1_000);
    trade(21000);
    await at(bucket(1) + 1_000);
    trade(21005);
    await at(bucket(2) + 2_000);

    expect(previous).toEqual([null, new Date(bucket(0)).toISOString()]);
  });

  it("A97: a bucket nothing traded in is skipped — the next close names the last bar actually published", async () => {
    // The engine reads this to tell REST lagging from a real gap; an
    // untraded bucket must not look like a bar REST is missing.
    const { previous, trade } = wireWithPrevious();
    await at(bucket(0) + 1_000);
    trade(21000);
    await at(bucket(2) + 1_000);
    trade(21010);
    await at(bucket(3) + 2_000);

    expect(previous).toEqual([null, new Date(bucket(0)).toISOString()]);
  });

  it("A97: a trade stamped in a bucket the grace flush already closed is dropped — the quiet bucket after it is not published", async () => {
    const published: BarData[] = [];
    const agg = new BarAggregator("1m");
    agg.onBarClose((bar) => published.push(bar));
    await at(bucket(0) + 1_000);
    agg.addTrade(21000, 1, Date.now());
    // The grace flush closes bucket 0 and seeds bucket 1; then a trade
    // stamped inside bucket 0 arrives late.
    await at(bucket(1) + 2_000);
    agg.addTrade(21020, 3, bucket(0) + 59_000);
    await at(bucket(2) + 2_000);

    expect(published.map((b) => b.timestamp)).toEqual([new Date(bucket(0)).toISOString()]);
    expect(published[0].close).toBe(21000);
  });

  it("A97: a trade stamped in a bucket a later trade already closed is dropped — it moves neither the closed bar nor the bar in progress", async () => {
    const published: BarData[] = [];
    const agg = new BarAggregator("1m");
    agg.onBarClose((bar) => published.push(bar));
    await at(bucket(0) + 1_000);
    agg.addTrade(21000, 1, Date.now());
    // A trade in bucket 1 closes bucket 0 before its grace flush; then a trade
    // stamped inside bucket 0 arrives late.
    await at(bucket(1) + 500);
    agg.addTrade(21010, 1, Date.now());
    expect(published).toHaveLength(1);
    agg.addTrade(20900, 1, bucket(0) + 59_000);
    await at(bucket(2) + 2_000);

    expect(published.map((b) => b.timestamp)).toEqual([
      new Date(bucket(0)).toISOString(),
      new Date(bucket(1)).toISOString(),
    ]);
    expect(published[0]).toMatchObject({ high: 21000, low: 21000, close: 21000, volume: 1 });
    expect(published[1]).toMatchObject({ open: 21010, high: 21010, low: 21010, close: 21010, volume: 1 });
  });

  it("A97: dispose forgets the previous close", async () => {
    const { agg, previous, trade } = wireWithPrevious();
    await at(bucket(0) + 1_000);
    trade(21000);
    await at(bucket(1) + 2_000);
    agg.dispose();
    agg.onBarClose((_bar, previousPublishedAt) => previous.push(previousPublishedAt));

    await at(bucket(2) + 1_000);
    trade(21010);
    await at(bucket(3) + 2_000);

    expect(previous).toEqual([null, null]);
  });
});
