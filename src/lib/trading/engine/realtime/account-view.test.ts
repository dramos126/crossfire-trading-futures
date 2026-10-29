import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Order, Position } from "@/lib/brokers/types";
import {
  ACCOUNT_VIEW_FAILURE_HOLD_MS,
  ACCOUNT_VIEW_MAX_AGE_MS,
  applyOrderEvent,
  applyPositionEvent,
  freshOrders,
  freshPositions,
  readOrdersThrough,
  readPositionsThrough,
  recordOrders,
  recordPositions,
  resetAccountViewForTests,
} from "./account-view";

const ACCT = 4242;
const OTHER = 7777;
const MNQ = "CON.F.US.MNQ.Z26";
const MES = "CON.F.US.MES.Z26";

function position(over: Partial<Position> = {}): Position {
  return {
    id: 1,
    accountId: ACCT,
    contractId: MNQ,
    creationTimestamp: "2026-10-23T14:00:00.000Z",
    type: 1,
    size: 2,
    averagePrice: 21000,
    ...over,
  };
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: 900,
    accountId: ACCT,
    contractId: MNQ,
    creationTimestamp: "2026-10-23T14:00:00.000Z",
    updateTimestamp: "2026-10-23T14:00:00.000Z",
    status: 1,
    type: 4,
    side: 1,
    size: 2,
    limitPrice: null,
    stopPrice: 20950,
    filledPrice: null,
    ...over,
  };
}

/** A promise the test resolves by hand, so concurrent callers can be parked on it. */
function parked<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetAccountViewForTests();
  vi.useFakeTimers();
  // A Friday inside the RTH session; nothing here reads the calendar, the
  // pin only makes `Date.now()` deterministic for the 60 s arithmetic.
  vi.setSystemTime(new Date("2026-10-23T14:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("account view — sweep writes", () => {
  it("holds positions, orders, asOf and source per account", () => {
    recordPositions(ACCT, [position()], "sweep");
    recordOrders(ACCT, [order()], "sweep");

    const p = freshPositions(ACCT);
    const o = freshOrders(ACCT);
    expect(p?.items).toEqual([position()]);
    expect(p?.source).toBe("sweep");
    expect(p?.asOf).toBe(Date.now());
    expect(o?.items).toEqual([order()]);
    expect(o?.source).toBe("sweep");
    expect(freshPositions(OTHER)).toBeNull();
  });

  it("a write replaces that account's slice whole and leaves the other slice and accounts alone", () => {
    recordPositions(ACCT, [position(), position({ id: 2, contractId: MES })], "sweep");
    recordOrders(ACCT, [order()], "sweep");
    recordPositions(OTHER, [position({ accountId: OTHER })], "sweep");

    recordPositions(ACCT, [position({ size: 1 })], "sweep");

    expect(freshPositions(ACCT)?.items).toEqual([position({ size: 1 })]);
    expect(freshOrders(ACCT)?.items).toEqual([order()]);
    expect(freshPositions(OTHER)?.items).toEqual([position({ accountId: OTHER })]);
  });

  it("is fresh under 60 s and stale at 60 s", () => {
    recordPositions(ACCT, [position()], "sweep");
    vi.advanceTimersByTime(ACCOUNT_VIEW_MAX_AGE_MS - 1);
    expect(freshPositions(ACCT)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(freshPositions(ACCT)).toBeNull();
  });
});

describe("account view — hub events", () => {
  it("a position frame replaces its contract's row and stamps the slice hub", () => {
    recordPositions(ACCT, [position(), position({ id: 2, contractId: MES, size: 1 })], "sweep");
    vi.advanceTimersByTime(10_000);

    applyPositionEvent(ACCT, position({ size: 3, averagePrice: 21010 }));

    const slice = freshPositions(ACCT);
    expect(slice?.items).toEqual([
      position({ id: 2, contractId: MES, size: 1 }),
      position({ size: 3, averagePrice: 21010 }),
    ]);
    expect(slice?.source).toBe("hub");
    expect(slice?.asOf).toBe(Date.now());
  });

  it("a size-0 frame removes the contract", () => {
    recordPositions(ACCT, [position(), position({ id: 2, contractId: MES })], "sweep");
    applyPositionEvent(ACCT, position({ size: 0 }));
    expect(freshPositions(ACCT)?.items.map((p) => p.contractId)).toEqual([MES]);
  });

  it("a frame does not extend the 60 s rule — it says nothing about the rest of the slice", () => {
    recordPositions(ACCT, [position()], "sweep");
    vi.advanceTimersByTime(ACCOUNT_VIEW_MAX_AGE_MS - 1_000);
    applyPositionEvent(ACCT, position({ size: 1 }));
    vi.advanceTimersByTime(1_000);
    expect(freshPositions(ACCT)).toBeNull();
  });

  it("a frame with no slice builds nothing", () => {
    applyPositionEvent(ACCT, position());
    applyOrderEvent(ACCT, order());
    expect(freshPositions(ACCT)).toBeNull();
    expect(freshOrders(ACCT)).toBeNull();
  });

  it("an open order frame upserts by id, a terminal one removes it", () => {
    recordOrders(ACCT, [order(), order({ id: 901, type: 1, limitPrice: 21100, stopPrice: null })], "sweep");

    applyOrderEvent(ACCT, order({ stopPrice: 21000 }));
    expect(freshOrders(ACCT)?.items.find((o) => o.id === 900)?.stopPrice).toBe(21000);
    expect(freshOrders(ACCT)?.source).toBe("hub");

    applyOrderEvent(ACCT, order({ id: 901, status: 3 }));
    expect(freshOrders(ACCT)?.items.map((o) => o.id)).toEqual([900]);

    applyOrderEvent(ACCT, order({ id: 902, status: 1 }));
    expect(freshOrders(ACCT)?.items.map((o) => o.id)).toEqual([900, 902]);
  });

  it("keeps only Working (1) orders, as the browser reducer does — 5 is expired and removes", () => {
    recordOrders(ACCT, [order(), order({ id: 901 })], "sweep");
    applyOrderEvent(ACCT, order({ id: 901, status: 5 }));
    applyOrderEvent(ACCT, order({ id: 903, status: 5 }));
    expect(freshOrders(ACCT)?.items.map((o) => o.id)).toEqual([900]);
  });
});

describe("account view — ask time", () => {
  it("a read asked before a hub frame landed is dropped; the frame's state stands", () => {
    recordPositions(ACCT, [position()], "sweep");
    const askedAt = Date.now() + 1_000;
    vi.advanceTimersByTime(2_000);
    applyPositionEvent(ACCT, position({ size: 0 }));

    const stood = recordPositions(ACCT, [position()], "route", askedAt);

    expect(freshPositions(ACCT)?.items).toEqual([]);
    expect(freshPositions(ACCT)?.source).toBe("hub");
    expect(stood.source).toBe("hub");
  });

  it("a slow read asked before a newer sweep write is dropped", () => {
    const slowAsk = Date.now();
    vi.advanceTimersByTime(5_000);
    recordOrders(ACCT, [order({ id: 950 })], "sweep");
    vi.advanceTimersByTime(10_000);

    recordOrders(ACCT, [order({ id: 900 })], "route", slowAsk);

    expect(freshOrders(ACCT)?.items.map((o) => o.id)).toEqual([950]);
    expect(freshOrders(ACCT)?.source).toBe("sweep");
  });

  it("a read asked after the slice's latest asOf lands, and readAt is its ask time", () => {
    recordPositions(ACCT, [position()], "sweep");
    vi.advanceTimersByTime(1_000);
    applyPositionEvent(ACCT, position({ size: 3 }));
    const askedAt = Date.now() + 1;
    vi.advanceTimersByTime(4_000);

    recordPositions(ACCT, [position({ size: 1 })], "sweep", askedAt);

    const slice = freshPositions(ACCT);
    expect(slice?.items).toEqual([position({ size: 1 })]);
    expect(slice?.readAt).toBe(askedAt);
    expect(slice?.asOf).toBe(askedAt);
  });

  it("the read-through stamps the ask time, not the landing time", async () => {
    const gate = parked<Position[]>();
    const askedAt = Date.now();
    const p = readPositionsThrough(ACCT, () => gate.promise, "route");
    vi.advanceTimersByTime(10_000);
    gate.resolve([position()]);
    await p;
    expect(freshPositions(ACCT)?.readAt).toBe(askedAt);
  });
});

describe("account view — read-through", () => {
  it("answers a fresh view with no fetch", async () => {
    recordPositions(ACCT, [position()], "sweep");
    const fetch = vi.fn(async () => [] as Position[]);

    const slice = await readPositionsThrough(ACCT, fetch, "route");

    expect(fetch).not.toHaveBeenCalled();
    expect(slice.items).toEqual([position()]);
    expect(slice.source).toBe("sweep");
  });

  it("N concurrent callers on a missing view share one fetch, and its result is stored", async () => {
    const gate = parked<Position[]>();
    const fetch = vi.fn(() => gate.promise);

    const waiters = Array.from({ length: 5 }, () => readPositionsThrough(ACCT, fetch, "route"));
    gate.resolve([position()]);
    const slices = await Promise.all(waiters);

    expect(fetch).toHaveBeenCalledTimes(1);
    for (const s of slices) expect(s.items).toEqual([position()]);
    expect(freshPositions(ACCT)?.source).toBe("route");
    expect(freshPositions(ACCT)?.items).toEqual([position()]);
  });

  it("a stale view is re-read once, then served", async () => {
    recordOrders(ACCT, [order()], "sweep");
    vi.advanceTimersByTime(ACCOUNT_VIEW_MAX_AGE_MS);
    const fetch = vi.fn(async () => [order({ id: 950 })]);

    await Promise.all([readOrdersThrough(ACCT, fetch, "route"), readOrdersThrough(ACCT, fetch, "route")]);
    await readOrdersThrough(ACCT, fetch, "route");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(freshOrders(ACCT)?.items.map((o) => o.id)).toEqual([950]);
  });

  it("is one fetch per account, not one overall", async () => {
    const fetch = vi.fn(async () => [] as Position[]);
    await Promise.all([
      readPositionsThrough(ACCT, fetch, "route"),
      readPositionsThrough(OTHER, fetch, "route"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a failed fetch rejects every waiter and stores no slice", async () => {
    const gate = parked<Position[]>();
    const fetch = vi.fn(() => gate.promise);

    const waiters = [readPositionsThrough(ACCT, fetch, "route"), readPositionsThrough(ACCT, fetch, "route")];
    gate.reject(new Error("429"));
    for (const w of waiters) await expect(w).rejects.toThrow("429");
    expect(freshPositions(ACCT)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// A115: in a 429 storm the sweeps are refused, the slice goes past 60 s and
// the stream is down, so every tab polls at 2.5 s. Without the memory each of
// those polls is a new live read.
describe("account view — a failed read is remembered for 30 s", () => {
  it("with no slice, N callers within 30 s get the stored error and make no broker call", async () => {
    const fetch = vi.fn(async (): Promise<Position[]> => {
      throw new Error("429");
    });
    await expect(readPositionsThrough(ACCT, fetch, "route")).rejects.toThrow("429");

    vi.advanceTimersByTime(ACCOUNT_VIEW_FAILURE_HOLD_MS - 1);
    for (let i = 0; i < 10; i++) {
      await expect(readPositionsThrough(ACCT, fetch, "route")).rejects.toThrow("429");
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("with a stale slice, callers within 30 s get it with its old asOf and source", async () => {
    recordOrders(ACCT, [order()], "sweep");
    const sweptAt = Date.now();
    vi.advanceTimersByTime(ACCOUNT_VIEW_MAX_AGE_MS);
    const fetch = vi.fn(async (): Promise<Order[]> => {
      throw new Error("429");
    });
    await expect(readOrdersThrough(ACCT, fetch, "route")).rejects.toThrow("429");

    const slices = await Promise.all(Array.from({ length: 5 }, () => readOrdersThrough(ACCT, fetch, "route")));

    expect(fetch).toHaveBeenCalledTimes(1);
    for (const s of slices) {
      expect(s.items).toEqual([order()]);
      expect(s.asOf).toBe(sweptAt);
      expect(s.source).toBe("sweep");
    }
  });

  it("after 30 s one retry happens, shared by concurrent callers", async () => {
    const fetch = vi.fn(async (): Promise<Position[]> => {
      throw new Error("429");
    });
    await expect(readPositionsThrough(ACCT, fetch, "route")).rejects.toThrow("429");
    vi.advanceTimersByTime(ACCOUNT_VIEW_FAILURE_HOLD_MS);
    fetch.mockResolvedValueOnce([position()]);

    const slices = await Promise.all([readPositionsThrough(ACCT, fetch, "route"), readPositionsThrough(ACCT, fetch, "route")]);

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const s of slices) expect(s.items).toEqual([position()]);
    expect(freshPositions(ACCT)?.source).toBe("route");
  });

  it("is per kind and per account", async () => {
    const failing = vi.fn(async (): Promise<Position[]> => {
      throw new Error("429");
    });
    await expect(readPositionsThrough(ACCT, failing, "route")).rejects.toThrow("429");

    const ok = vi.fn(async () => [] as Position[]);
    await readPositionsThrough(OTHER, ok, "route");
    await readOrdersThrough(ACCT, vi.fn(async () => [] as Order[]), "route");
    expect(ok).toHaveBeenCalledTimes(1);
    expect(freshOrders(ACCT)).not.toBeNull();
  });
});
