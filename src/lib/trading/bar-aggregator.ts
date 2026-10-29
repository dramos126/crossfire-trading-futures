import type { BarData } from "@/lib/brokers/types";
import type { Timeframe } from "@/lib/trading/domain";
import { log } from "@/lib/logger";

/**
 * Aggregates GatewayTrade ticks into closed bars for a given timeframe,
 * replacing the 30s REST polling loop with event-driven bar closes.
 *
 * Why this exists: the Topstep market hub only streams tick-level events
 * (quotes, trades, DOM) — no candle events. To evaluate strategy hooks at
 * the instant a bar closes we have to fold ticks into OHLCV ourselves.
 *
 * Correctness notes:
 * - Bar timestamp convention: open-time, UTC ISO string. This matches what
 *   `retrieveBars` returns so warmup + live bars stitch cleanly.
 * - Boundary detection: wall-clock floor (not trade-count), because we
 *   MUST emit even when no trades print in the last N seconds of a bar —
 *   otherwise low-volume contracts stall the strategy. A grace timer fires
 *   the close shortly after the boundary regardless of trade flow.
 * - The very first tick after construction seeds the current bar; we do
 *   NOT emit a close for partial data accumulated before that first tick.
 * - **A bucket no trade landed in is never emitted.** The grace timer still
 *   re-seeds the next bucket from `lastSeenPrice` so a contract that goes
 *   quiet does not gap on its next real trade — that part is deliberate and
 *   stays — but a seed nothing traded into is not a bar and must not be
 *   published as one. Every consumer of a close treats it as market truth:
 *   the engine appends it to the REST series as `triggerBar` and hands it to
 *   `shouldEnter`, so during silence the aggregator was manufacturing flat
 *   bars at the last price, indefinitely, and a strategy could enter on a
 *   bar that never traded. `hasTrade` is the discriminator rather than
 *   `volume === 0`, because a broker trade frame carrying zero size is still
 *   a print and a real zero-volume bar from REST is still the provider's
 *   answer; what disqualifies a bar here is that the aggregator invented it.
 */

/**
 * `previousPublishedAt` is the open time of the bar this aggregator published
 * before `bar`, or null for its first. It is what lets the engine tell a hole
 * in REST's series (a bar published here that REST does not hold yet) from a
 * gap that is real — the daily halt, a weekend, or a bucket nothing traded in,
 * none of which this aggregator publishes either.
 */
export type BarCloseHandler = (bar: BarData, previousPublishedAt: string | null) => void;

interface PartialBar {
  openMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** At least one trade was folded into this bucket. False on a bar the
   *  grace timer seeded from `lastSeenPrice` and nothing ever traded into. */
  hasTrade: boolean;
}

export const TIMEFRAME_TO_MS: Readonly<Record<Timeframe, number>> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** Milliseconds past the bar boundary before we force-emit if no tick arrives. */
const GRACE_MS = 1_500;

/** Cap on how many times the grace timer can reschedule itself before
 *  giving up. Protects against a runaway loop if the system clock is being
 *  adjusted backward — without this, an early-firing timer + reschedule
 *  pair could spin forever. */
const MAX_GRACE_RESCHEDULES = 5;

export class BarAggregator {
  private readonly bucketMs: number;
  private current: PartialBar | null = null;
  private handler: BarCloseHandler | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private graceReschedules = 0;
  private lastSeenPrice: number | null = null;
  private lastPublishedAt: string | null = null;

  constructor(timeframe: Timeframe) {
    this.bucketMs = TIMEFRAME_TO_MS[timeframe];
  }

  onBarClose(handler: BarCloseHandler): void {
    this.handler = handler;
  }

  /**
   * Fold a trade into the current bar. If the trade's timestamp falls into
   * a later bucket than the one in progress, close the prior bar(s) first.
   */
  addTrade(price: number, volume: number, timestampMs: number): void {
    const bucketStart = Math.floor(timestampMs / this.bucketMs) * this.bucketMs;

    if (this.current == null) {
      this.current = this.seedBar(bucketStart, price, volume, true);
      this.scheduleGrace(bucketStart);
      this.lastSeenPrice = price;
      return;
    }

    // A trade stamped before the bucket in progress belongs to a bucket that
    // has already closed, whether the grace flush or a later trade closed it.
    // Folding it in would misstate this bucket's prices, and on a grace seed
    // mark a bucket nothing traded in as traded and publish it, which the
    // engine then reads as a bar REST is missing. Drop it. `handleTrade`
    // sorts each batch by trade time, so a batch never drops its own trades.
    if (bucketStart < this.current.openMs) return;

    if (bucketStart > this.current.openMs) {
      // Close the in-progress bar. If the new trade skipped over one or
      // more empty buckets, we still only emit one close — intermediate
      // empty buckets carry no information and would confuse indicators.
      this.emitClose(this.current);
      this.current = this.seedBar(bucketStart, price, volume, true);
      this.scheduleGrace(bucketStart);
    } else {
      // Same bucket: update OHLCV. `hasTrade` promotes a grace-seeded bar to
      // a real one — its `open` stays at the seeded last price, which is the
      // continuity the seed exists for, but it is now a bucket that traded.
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      this.current.volume += volume;
      this.current.hasTrade = true;
    }
    this.lastSeenPrice = price;
  }

  /**
   * Called by the grace timer — emits a close for the current bar even if
   * no trade has arrived in the next bucket. Needed for low-volume contracts
   * where the aggregator would otherwise never fire the close.
   */
  private flushIfBoundaryPassed(expectedOpenMs: number): void {
    this.graceTimer = null;
    if (!this.current || this.current.openMs !== expectedOpenMs) return;

    const now = Date.now();
    if (now < expectedOpenMs + this.bucketMs) {
      // Timer fired early (clock jitter); reschedule. Cap reschedules so a
      // backward-moving system clock can't spin this forever.
      if (this.graceReschedules >= MAX_GRACE_RESCHEDULES) {
        log.warn(
          "bar-aggregator",
          `grace timer rescheduled ${this.graceReschedules} times for openMs=${expectedOpenMs}; force-emitting to avoid loop`,
        );
      } else {
        this.graceReschedules++;
        this.scheduleGrace(expectedOpenMs);
        return;
      }
    }

    this.graceReschedules = 0;
    this.emitClose(this.current);

    // Seed the next bar using the last seen price as open/high/low/close
    // and zero volume. Without this, a contract that goes quiet after a
    // close would produce a gap on the next real trade.
    //
    // The seed carries `hasTrade: false`, so if the silence continues this
    // bar is re-seeded and never published. The chain must keep running
    // through the silence rather than stopping: `current` is what the next
    // real trade compares its bucket against, and leaving it parked on an
    // already-emitted bar would emit that bar a second time.
    const nextBucketStart = expectedOpenMs + this.bucketMs;
    if (this.lastSeenPrice != null) {
      this.current = this.seedBar(nextBucketStart, this.lastSeenPrice, 0, false);
      this.scheduleGrace(nextBucketStart);
    } else {
      this.current = null;
    }
  }

  private scheduleGrace(bucketStart: number): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const fireAt = bucketStart + this.bucketMs + GRACE_MS;
    const delay = Math.max(0, fireAt - Date.now());
    this.graceTimer = setTimeout(() => this.flushIfBoundaryPassed(bucketStart), delay);
  }

  private seedBar(openMs: number, price: number, volume: number, hasTrade: boolean): PartialBar {
    return {
      openMs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
      hasTrade,
    };
  }

  private emitClose(bar: PartialBar): void {
    if (!bar.hasTrade) return;
    if (!this.handler) return;
    const out: BarData = {
      timestamp: new Date(bar.openMs).toISOString(),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    };
    const previousPublishedAt = this.lastPublishedAt;
    this.lastPublishedAt = out.timestamp;
    this.handler(out, previousPublishedAt);
  }

  /** Stop the grace timer. Call on unsubscribe / engine stop. */
  dispose(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.current = null;
    this.handler = null;
    this.lastPublishedAt = null;
  }
}
