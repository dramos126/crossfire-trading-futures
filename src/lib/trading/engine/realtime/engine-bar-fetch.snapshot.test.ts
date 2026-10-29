/**
 * A trade row holds its *execution* contract — `MNQU6` on a Tradovate leg —
 * and the market-data slot is one global provider keyed in Topstep's
 * namespace. Asking it for bars on the execution id failed four for four on
 * Tradovate in the 2026-08-26 soak (bugs.md A54).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IndicatorConfig } from "@/lib/trading/domain";

const TRADOVATE_TRADE_ID = 400;
const EXECUTION_CONTRACT_ID = "MNQU6";
const MARKET_DATA_CONTRACT_ID = "CON.F.US.MNQ.U26";

/** The queue columns of `strategy_trade_bars`, as `listDueSnapshots`,
 *  `incrementSnapshotRetry` and `abandonSnapshotQueue` read and write them. */
interface QueueRow {
  tradeId: number;
  dueAt: string | null;
  retryCount: number;
}

const db = vi.hoisted(() => {
  const queue = new Map<number, { tradeId: number; dueAt: string | null; retryCount: number }>();
  return {
    queue,
    getTradeById: vi.fn(),
    saveTradeBars: vi.fn(),
    listDueSnapshots: vi.fn((now: string, retryLimit: number, limit: number) =>
      [...queue.values()]
        .filter((r) => r.dueAt != null && r.dueAt <= now && r.retryCount < retryLimit)
        .sort((a, b) => (a.dueAt! < b.dueAt! ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ tradeId: r.tradeId, retryCount: r.retryCount })),
    ),
    incrementSnapshotRetry: vi.fn((tradeId: number) => {
      const row = queue.get(tradeId);
      if (!row) return 0;
      row.retryCount += 1;
      return row.retryCount;
    }),
    abandonSnapshotQueue: vi.fn((tradeId: number) => {
      const row = queue.get(tradeId);
      if (row) row.dueAt = null;
    }),
  };
});
vi.mock("@/lib/db/trades", () => db);
vi.mock("@/lib/db/deployments", () => ({ getDeployment: () => null }));
const strategyIndicators = vi.hoisted(() => ({ configs: [] as IndicatorConfig[] }));
vi.mock("../../strategies", () => ({
  getStrategy: () => ({
    params: [],
    config: { timeframe: "5m", indicators: strategyIndicators.configs },
  }),
}));
const provider = vi.hoisted(() => ({ retrieveBars: vi.fn() }));
vi.mock("@/lib/market-data/registry-singleton", () => ({
  marketDataRegistry: { realtime: () => provider },
}));

import {
  resetBarFetchCache,
  resolveExitFillPrice,
  runSnapshotQueue,
  snapshotTradeBars,
  SNAPSHOT_PER_TICK_LIMIT,
  SNAPSHOT_RETRY_DELAY_MS,
  SNAPSHOT_RETRY_LIMIT,
  type SnapshotOutcome,
  type SnapshotQueueDeps,
} from "./engine-bar-fetch";

interface WarnRecord {
  message: string;
}

beforeEach(() => {
  strategyIndicators.configs = [];
  db.queue.clear();
  resetBarFetchCache();
  db.getTradeById.mockReset();
  db.saveTradeBars.mockReset();
  db.listDueSnapshots.mockClear();
  db.incrementSnapshotRetry.mockClear();
  db.abandonSnapshotQueue.mockClear();
  provider.retrieveBars.mockReset();
  db.getTradeById.mockReturnValue({
    id: TRADOVATE_TRADE_ID,
    deploymentId: null,
    strategyKey: "any",
    contractId: EXECUTION_CONTRACT_ID,
    paramSnapshot: null,
    entryFilledAt: "2026-08-26T14:00:00.000Z",
    entrySubmittedAt: "2026-08-26T14:00:00.000Z",
    exitFilledAt: "2026-08-26T15:00:00.000Z",
  });
  provider.retrieveBars.mockResolvedValue([
    { t: "2026-08-26T14:00:00.000Z", o: 1, h: 1, l: 1, c: 1, v: 1 },
  ]);
});

describe("snapshotTradeBars", () => {
  it("A54: asks the market-data provider for the market-data contract, not the trade's execution contract", async () => {
    const warns: WarnRecord[] = [];
    await snapshotTradeBars(
      TRADOVATE_TRADE_ID,
      (_d, _s, _c, message) => warns.push({ message }),
      async (id) => (id === EXECUTION_CONTRACT_ID ? MARKET_DATA_CONTRACT_ID : null),
    );

    expect(provider.retrieveBars).toHaveBeenCalledTimes(1);
    expect(provider.retrieveBars.mock.calls[0][0].contractId).toBe(MARKET_DATA_CONTRACT_ID);
    expect(db.saveTradeBars).toHaveBeenCalledTimes(1);
    expect(warns).toEqual([]);
  });

  it("fetches nothing and warns when the market-data contract cannot be told", async () => {
    const warns: WarnRecord[] = [];
    await snapshotTradeBars(
      TRADOVATE_TRADE_ID,
      (_d, _s, _c, message) => warns.push({ message }),
      async () => null,
    );

    expect(provider.retrieveBars).not.toHaveBeenCalled();
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain(EXECUTION_CONTRACT_ID);
  });

  it("replay/snapshot warmup under-fetches for MACD: the pre-entry window covers MACD's `slow` lookback", async () => {
    const MACD_SLOW = 200;
    const FIVE_MINUTES_MS = 5 * 60_000;
    strategyIndicators.configs = [{ id: "macd", type: "MACD", params: { fast: 12, slow: MACD_SLOW, signal: 9 } }];

    await snapshotTradeBars(TRADOVATE_TRADE_ID, () => {}, async () => MARKET_DATA_CONTRACT_ID);

    const { startTime } = provider.retrieveBars.mock.calls[0][0];
    const barsBeforeEntry = (Date.parse("2026-08-26T14:00:00.000Z") - Date.parse(startTime)) / FIVE_MINUTES_MS;
    expect(barsBeforeEntry).toBe(MACD_SLOW * 2 + 50);
  });

  it("A16: answers retry when the provider has no bars for the window yet, and saves nothing", async () => {
    provider.retrieveBars.mockResolvedValue([]);
    const outcome = await snapshotTradeBars(TRADOVATE_TRADE_ID, () => {}, async () => MARKET_DATA_CONTRACT_ID);
    expect(outcome.kind).toBe("retry");
    expect(db.saveTradeBars).not.toHaveBeenCalled();
  });

  it("A16: answers retire when the trade row is gone, which no later attempt can change", async () => {
    db.getTradeById.mockReturnValue(undefined);
    const outcome = await snapshotTradeBars(TRADOVATE_TRADE_ID, () => {}, async () => MARKET_DATA_CONTRACT_ID);
    expect(outcome.kind).toBe("retire");
    expect(provider.retrieveBars).not.toHaveBeenCalled();
  });

  it("A16: answers retry on a failed read, after its warn", async () => {
    provider.retrieveBars.mockRejectedValue(new Error("429"));
    const warns: WarnRecord[] = [];
    const outcome = await snapshotTradeBars(
      TRADOVATE_TRADE_ID,
      (_d, _s, _c, message) => warns.push({ message }),
      async () => MARKET_DATA_CONTRACT_ID,
    );
    expect(outcome).toEqual({ kind: "retry", reason: "429" });
    expect(warns).toHaveLength(1);
  });

  it("answers defer, not retry, when the read was refused for rate", async () => {
    provider.retrieveBars.mockRejectedValue(rateLimited());
    const outcome = await snapshotTradeBars(TRADOVATE_TRADE_ID, () => {}, async () => MARKET_DATA_CONTRACT_ID);
    expect(outcome.kind).toBe("defer");
  });
});

/** A read the provider refused for rate, carrying the HTTP status the way the
 *  queue reads it: structurally, off a `status` field, never off the text. */
function rateLimited(): Error {
  return Object.assign(new Error("Topstep API error 429 on /api/History/retrieveBars"), { status: 429 });
}

/**
 * The re-snapshot queue. Every outcome has to advance the row: before A16 the
 * bail paths returned without touching it, so a window with no bars re-ran on
 * every 15s reconcile tick for as long as the provider had none.
 */
describe("runSnapshotQueue", () => {
  const T0 = Date.parse("2026-10-23T15:00:00.000Z");
  const RECONCILE_TICK_MS = 15_000;

  interface QueueLog {
    severity: "info" | "warn";
    message: string;
  }

  function queueRow(tradeId: number, dueAt = "2026-10-23T14:00:00.000Z"): void {
    const row: QueueRow = { tradeId, dueAt, retryCount: 0 };
    db.queue.set(tradeId, row);
  }

  function harness(answer: (tradeId: number) => SnapshotOutcome, passive = { on: false }) {
    const asked: number[] = [];
    const logs: QueueLog[] = [];
    const deps = {
      passive: () => passive.on,
      snapshot: async (tradeId: number) => {
        asked.push(tradeId);
        return answer(tradeId);
      },
      log: (_d: string, severity: "info" | "warn", _c: unknown, message: string) => {
        logs.push({ severity, message });
      },
    } satisfies SnapshotQueueDeps;
    return { deps, asked, logs };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-run a window with no bars on the next tick, and does after its retry delay", async () => {
    queueRow(1);
    const { deps, asked } = harness(() => ({ kind: "retry", reason: "no bars" }));

    await runSnapshotQueue(deps);
    expect(asked).toEqual([1]);
    expect(db.queue.get(1)?.retryCount).toBe(1);

    vi.setSystemTime(T0 + RECONCILE_TICK_MS);
    await runSnapshotQueue(deps);
    expect(asked).toEqual([1]);

    vi.setSystemTime(T0 + SNAPSHOT_RETRY_DELAY_MS);
    await runSnapshotQueue(deps);
    expect(asked).toEqual([1, 1]);
    expect(db.queue.get(1)?.retryCount).toBe(2);
  });

  it("retires a row on a permanent bail, and never asks it again", async () => {
    queueRow(1);
    const { deps, asked, logs } = harness(() => ({ kind: "retire", reason: "the trade row is gone" }));

    await runSnapshotQueue(deps);
    vi.setSystemTime(T0 + SNAPSHOT_RETRY_DELAY_MS);
    await runSnapshotQueue(deps);

    expect(asked).toEqual([1]);
    expect(db.queue.get(1)?.dueAt).toBeNull();
    expect(db.incrementSnapshotRetry).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("the trade row is gone");
  });

  it("gives up after the retry limit, said once at warn", async () => {
    queueRow(1);
    const { deps, asked, logs } = harness(() => ({ kind: "retry", reason: "no bars" }));

    for (let i = 0; i < SNAPSHOT_RETRY_LIMIT + 2; i++) {
      vi.setSystemTime(T0 + i * SNAPSHOT_RETRY_DELAY_MS);
      await runSnapshotQueue(deps);
    }

    expect(asked).toHaveLength(SNAPSHOT_RETRY_LIMIT);
    expect(db.queue.get(1)?.dueAt).toBeNull();
    expect(logs.filter((l) => l.severity === "warn")).toHaveLength(1);
  });

  it("does not let rows waiting out their delay starve the rows due behind them", async () => {
    // Earliest-due first, and the per-tick limit's worth of them all defer.
    for (let id = 1; id <= SNAPSHOT_PER_TICK_LIMIT; id++) queueRow(id, `2026-10-23T13:0${id}:00.000Z`);
    queueRow(99, "2026-10-23T14:00:00.000Z");
    const { deps, asked } = harness((id) => (id === 99 ? { kind: "saved" } : { kind: "retry", reason: "no bars" }));

    await runSnapshotQueue(deps);
    expect(asked).toEqual([1, 2, 3]);

    vi.setSystemTime(T0 + RECONCILE_TICK_MS);
    await runSnapshotQueue(deps);
    expect(asked).toEqual([1, 2, 3, 99]);
  });

  /**
   * A 429 storm longer than two retry delays used to spend all three attempts
   * and retire every due row. A rate refusal says nothing about the window, so
   * it defers the row without spending one. Driven through the real
   * `snapshotTradeBars`, which is what the engine's `snapshot` dep calls.
   */
  describe("a rate-limited read", () => {
    function throughSnapshot(err: () => Error) {
      provider.retrieveBars.mockImplementation(async () => {
        throw err();
      });
      const asked: number[] = [];
      const deps = {
        passive: () => false,
        snapshot: (tradeId: number) => {
          asked.push(tradeId);
          return snapshotTradeBars(tradeId, () => {}, async () => MARKET_DATA_CONTRACT_ID);
        },
        log: () => {},
      } satisfies SnapshotQueueDeps;
      return { deps, asked };
    }

    it("spends no attempt on three 429s, and the row is still due", async () => {
      queueRow(TRADOVATE_TRADE_ID);
      const { deps, asked } = throughSnapshot(rateLimited);

      for (let i = 0; i < SNAPSHOT_RETRY_LIMIT; i++) {
        vi.setSystemTime(T0 + i * SNAPSHOT_RETRY_DELAY_MS);
        await runSnapshotQueue(deps);
      }

      expect(asked).toHaveLength(SNAPSHOT_RETRY_LIMIT);
      expect(db.queue.get(TRADOVATE_TRADE_ID)?.retryCount).toBe(0);
      expect(db.queue.get(TRADOVATE_TRADE_ID)?.dueAt).not.toBeNull();
      expect(db.abandonSnapshotQueue).not.toHaveBeenCalled();

      // Still waits out the delay between asks.
      vi.setSystemTime(T0 + (SNAPSHOT_RETRY_LIMIT - 1) * SNAPSHOT_RETRY_DELAY_MS + RECONCILE_TICK_MS);
      await runSnapshotQueue(deps);
      expect(asked).toHaveLength(SNAPSHOT_RETRY_LIMIT);

      vi.setSystemTime(T0 + SNAPSHOT_RETRY_LIMIT * SNAPSHOT_RETRY_DELAY_MS);
      await runSnapshotQueue(deps);
      expect(asked).toHaveLength(SNAPSHOT_RETRY_LIMIT + 1);
    });

    it("retires the row after three other failed reads, as before", async () => {
      queueRow(TRADOVATE_TRADE_ID);
      const { deps } = throughSnapshot(() => new Error("Topstep API error 502 on /api/History/retrieveBars"));

      for (let i = 0; i < SNAPSHOT_RETRY_LIMIT; i++) {
        vi.setSystemTime(T0 + i * SNAPSHOT_RETRY_DELAY_MS);
        await runSnapshotQueue(deps);
      }

      expect(db.queue.get(TRADOVATE_TRADE_ID)?.retryCount).toBe(SNAPSHOT_RETRY_LIMIT);
      expect(db.queue.get(TRADOVATE_TRADE_ID)?.dueAt).toBeNull();
    });

    it("defers without spending an attempt when the snapshot dep itself throws a 429", async () => {
      queueRow(1);
      const deps = {
        passive: () => false,
        snapshot: async (): Promise<SnapshotOutcome> => {
          throw rateLimited();
        },
        log: () => {},
      } satisfies SnapshotQueueDeps;

      await runSnapshotQueue(deps);

      expect(db.incrementSnapshotRetry).not.toHaveBeenCalled();
      expect(db.queue.get(1)?.dueAt).not.toBeNull();
    });
  });

  /**
   * A15, documented rather than capped: the queue is a column on rows that
   * exist anyway, so a passive window costs no memory and spends no attempt.
   */
  it("A15: reads and spends nothing while passive, and resumes on the first active tick", async () => {
    queueRow(1);
    const passive = { on: true };
    const { deps, asked } = harness(() => ({ kind: "saved" }), passive);

    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(T0 + i * RECONCILE_TICK_MS);
      await runSnapshotQueue(deps);
    }
    expect(asked).toEqual([]);
    expect(db.listDueSnapshots).not.toHaveBeenCalled();
    expect(db.queue.get(1)?.retryCount).toBe(0);

    passive.on = false;
    await runSnapshotQueue(deps);
    expect(asked).toEqual([1]);
  });
});

describe("resolveExitFillPrice", () => {
  // A Tradovate fill names its contract by the numeric execution id.
  const NUMERIC_EXECUTION_ID = "4799969";

  it("A118: asks the provider for the market-data contract, not the trade's execution id", async () => {
    provider.retrieveBars.mockResolvedValue([{ close: 20_125.5 }]);
    const asked: string[] = [];

    const price = await resolveExitFillPrice({ contractId: NUMERIC_EXECUTION_ID }, async (id) => {
      asked.push(id);
      return MARKET_DATA_CONTRACT_ID;
    });

    expect(asked).toEqual([NUMERIC_EXECUTION_ID]);
    expect(provider.retrieveBars.mock.calls[0][0].contractId).toBe(MARKET_DATA_CONTRACT_ID);
    expect(price).toBe(20_125.5);
  });

  it("A118: fetches nothing and answers null when the market-data contract cannot be told", async () => {
    const price = await resolveExitFillPrice({ contractId: NUMERIC_EXECUTION_ID }, async () => null);
    expect(provider.retrieveBars).not.toHaveBeenCalled();
    expect(price).toBeNull();
  });
});
