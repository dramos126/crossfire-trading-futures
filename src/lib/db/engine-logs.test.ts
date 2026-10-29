import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { LogRecord } from "@/lib/logging/pipe";

/**
 * The store's flush, against a real in-memory database with the shipped
 * migration replayed. What it has to get right is an ordering: a burst
 * that opened inside the same batch has its row written a statement
 * earlier, so the count update lands on it rather than on nothing.
 */

const { migrations, handle, getDb } = vi.hoisted(() => {
  const handle = {
    db: null as Database.Database | null,
    closedForShutdown: false,
  };
  return {
    migrations: [] as Array<(d: Database.Database) => void>,
    handle,
    getDb: vi.fn(() => {
      if (!handle.db) throw new Error("no database open");
      return handle.db;
    }),
  };
});

vi.mock("@/lib/db/connection", () => ({
  getDb,
  isClosedForShutdown: () => handle.closedForShutdown,
  registerMigration: vi.fn((fn: (d: Database.Database) => void) => {
    migrations.push(fn);
  }),
}));

let store: typeof import("./engine-logs");

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: "2026-08-26T18:00:00.000Z",
    deploymentId: "d1",
    level: "warn",
    message: "fill not in tradovate_order_map — dropping",
    severity: "warn",
    category: "broker",
    event: null,
    display: null,
    accountId: null,
    contractId: null,
    ticker: null,
    tradeId: null,
    values: null,
    burstKey: "abc|d1|",
    burstCount: 1,
    lastSeenAt: "2026-08-26T18:00:00.000Z",
    ...over,
  };
}

function rows(): Array<Record<string, unknown>> {
  return handle.db!.prepare(`SELECT * FROM engine_logs ORDER BY id`).all() as Array<
    Record<string, unknown>
  >;
}

beforeEach(async () => {
  migrations.length = 0;
  vi.resetModules();
  handle.db = new Database(":memory:");
  store = await import("./engine-logs");
  for (const fn of migrations) fn(handle.db);
});

afterEach(() => {
  store._stopEngineLogStoreForTest();
  handle.db?.close();
  handle.db = null;
  handle.closedForShutdown = false;
});

describe("flush", () => {
  it("writes every envelope column", () => {
    store.persistEngineLog(
      record({
        level: "trade",
        severity: "info",
        category: "trade",
        event: "entry_filled",
        display: "…4469-ema-x.MNQ",
        accountId: 11444469,
        contractId: "CON.F.US.MNQ.Z25",
        tradeId: 4210,
      }),
    );
    store.flush();
    expect(rows()[0]).toMatchObject({
      level: "trade",
      severity: "info",
      category: "trade",
      event: "entry_filled",
      display: "…4469-ema-x.MNQ",
      account_id: 11444469,
      contract_id: "CON.F.US.MNQ.Z25",
      trade_id: 4210,
      burst_count: 1,
    });
  });

  it("does nothing when both queues are empty", () => {
    expect(() => store.flush()).not.toThrow();
    expect(rows()).toHaveLength(0);
  });

  // The evidence line: ~23 identical `fill … not in tradovate_order_map`
  // warnings in one boot frame.
  it("lands 23 identical warnings as one row carrying a count of 23", () => {
    store.persistEngineLog(record());
    for (let i = 2; i <= 23; i++) {
      store.persistBurstUpdate({
        burstKey: "abc|d1|",
        timestamp: "2026-08-26T18:00:00.000Z",
        count: i,
        lastSeenAt: `2026-08-26T18:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    store.flush();

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].burst_count).toBe(23);
    expect(all[0].last_seen_at).toBe("2026-08-26T18:00:23.000Z");
  });

  it("updates a row written by an earlier flush", () => {
    store.persistEngineLog(record());
    store.flush();
    store.persistBurstUpdate({
      burstKey: "abc|d1|",
      timestamp: "2026-08-26T18:00:00.000Z",
      count: 9,
      lastSeenAt: "2026-08-26T18:00:09.000Z",
    });
    store.flush();
    expect(rows()[0].burst_count).toBe(9);
  });

  it("keeps only the last count for a row, not one update per repeat", () => {
    store.persistEngineLog(record());
    for (const count of [2, 3, 4]) {
      store.persistBurstUpdate({
        burstKey: "abc|d1|",
        timestamp: "2026-08-26T18:00:00.000Z",
        count,
        lastSeenAt: "2026-08-26T18:00:04.000Z",
      });
    }
    store.flush();
    expect(rows()[0].burst_count).toBe(4);
  });

  it("leaves another row's count alone", () => {
    store.persistEngineLog(record({ burstKey: "abc|d1|" }));
    store.persistEngineLog(record({ burstKey: "abc|d2|", deploymentId: "d2" }));
    store.persistBurstUpdate({
      burstKey: "abc|d1|",
      timestamp: "2026-08-26T18:00:00.000Z",
      count: 5,
      lastSeenAt: "2026-08-26T18:00:05.000Z",
    });
    store.flush();
    const all = rows();
    expect(all.map((r) => r.burst_count)).toEqual([5, 1]);
  });

  it("re-queues both halves when the database is unavailable, and lands them on the retry", () => {
    const open = handle.db!;
    handle.db = null;
    store.persistEngineLog(record());
    store.persistBurstUpdate({
      burstKey: "abc|d1|",
      timestamp: "2026-08-26T18:00:00.000Z",
      count: 7,
      lastSeenAt: "2026-08-26T18:00:07.000Z",
    });
    store.flush();

    handle.db = open;
    store.flush();
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].burst_count).toBe(7);
  });

  it("writes nothing once the shutdown has closed the database — not even through the 5s timer", () => {
    vi.useFakeTimers();
    // The store binds a SIGTERM flush; keep it off the test runner's process.
    const bind = vi.spyOn(process, "prependOnceListener").mockReturnValue(process);
    try {
      store.startEngineLogStore();
      handle.closedForShutdown = true;
      getDb.mockClear();
      store.persistEngineLog(record());
      store.persistBurstUpdate({
        burstKey: "abc|d1|",
        timestamp: "2026-08-26T18:00:00.000Z",
        count: 3,
        lastSeenAt: "2026-08-26T18:00:03.000Z",
      });

      vi.advanceTimersByTime(5_000);
      store.flush();

      // `getDb()` is the call that would reopen the closed connection.
      expect(getDb).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(0);
    } finally {
      bind.mockRestore();
      vi.useRealTimers();
    }
  });

  it("the exit's final flush writes the lines queued after the close — the audit trail of what the drain waited for", () => {
    handle.closedForShutdown = true;
    store.persistEngineLog(record({ event: "flatten_all_complete", message: "flatten-all complete", burstKey: null }));
    store.persistBurstUpdate({
      burstKey: "abc|d1|",
      timestamp: "2026-08-26T18:00:00.000Z",
      count: 2,
      lastSeenAt: "2026-08-26T18:00:02.000Z",
    });
    store.persistEngineLog(record());
    store.flush();
    expect(rows()).toHaveLength(0);

    store.flushBeforeExit();

    const all = rows();
    expect(all.map((r) => r.event)).toEqual(["flatten_all_complete", null]);
    expect(all[1].burst_count).toBe(2);
  });
});

describe("hydrateRings", () => {
  it("splits heartbeats from the main ring and returns each oldest-first", () => {
    store.persistEngineLog(record({ level: "info", timestamp: "2026-08-26T18:00:01.000Z", message: "a", burstKey: "a" }));
    store.persistEngineLog(record({ level: "heartbeat", timestamp: "2026-08-26T18:00:02.000Z", message: "hb", burstKey: null }));
    store.persistEngineLog(record({ level: "warn", timestamp: "2026-08-26T18:00:03.000Z", message: "b", burstKey: "b" }));
    store.flush();

    const { main, heartbeat } = store.hydrateRings();
    expect(main.map((m) => m.message)).toEqual(["a", "b"]);
    expect(heartbeat.map((m) => m.message)).toEqual(["hb"]);
  });

  it("returns the four legacy fields the rings and /logs read", () => {
    store.persistEngineLog(record({ level: "connection", message: "hub up" }));
    store.flush();
    expect(store.hydrateRings().main[0]).toEqual({
      timestamp: "2026-08-26T18:00:00.000Z",
      deploymentId: "d1",
      level: "connection",
      message: "hub up",
    });
  });
});

describe("clearPersistedLogs", () => {
  it("drops the rows and the queued writes", () => {
    store.persistEngineLog(record());
    store.flush();
    store.persistEngineLog(record({ message: "queued but not flushed", burstKey: "z" }));
    store.clearPersistedLogs();
    store.flush();
    expect(rows()).toHaveLength(0);
  });
});

describe("the retention prune", () => {
  // Both processes queue and flush their own lines into one table once the
  // roles split; one sweeper is enough, and it is the engine's — the web
  // role starts the flush alone.
  const EXPIRED = "2000-01-01T00:00:00.000Z";
  const DAY_MS = 24 * 60 * 60 * 1000;

  function startWithExpiredRow(start: () => void): void {
    store.persistEngineLog(record({ timestamp: EXPIRED, burstKey: null }));
    store.flush();
    const bind = vi.spyOn(process, "prependOnceListener").mockReturnValue(process);
    try {
      start();
    } finally {
      bind.mockRestore();
    }
  }

  it("deletes expired rows when the full store starts — the engine's start", () => {
    startWithExpiredRow(store.startEngineLogStore);
    expect(rows()).toHaveLength(0);
  });

  it("is not run by the flush alone — the web role's start — at start or on any later day", () => {
    vi.useFakeTimers();
    try {
      startWithExpiredRow(store.startEngineLogFlush);
      vi.advanceTimersByTime(2 * DAY_MS);
      expect(rows().map((r) => r.timestamp)).toEqual([EXPIRED]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still writes a web process's own lines on the flush timer", () => {
    vi.useFakeTimers();
    const bind = vi.spyOn(process, "prependOnceListener").mockReturnValue(process);
    try {
      store.startEngineLogFlush();
      store.persistEngineLog(record({ message: "web line", burstKey: null }));
      expect(rows()).toHaveLength(0);
      vi.advanceTimersByTime(5_000);
      expect(rows().map((r) => r.message)).toEqual(["web line"]);
    } finally {
      bind.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts the retention sweep when the engine's start follows the web role's flush", () => {
    startWithExpiredRow(() => {
      store.startEngineLogFlush();
      store.startEngineLogStore();
    });
    expect(rows()).toHaveLength(0);
  });
});
