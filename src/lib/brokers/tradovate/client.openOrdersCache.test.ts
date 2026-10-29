/**
 * The 1 s open-orders cache has Topstep's two guards (punchlist,
 * tradovate-open-orders-cache-stale-after-mutation): every place, cancel and
 * modify invalidates in a `finally` once the request is sent, because a
 * request that throws may still have reached the gateway; and a read in
 * flight is shared per account, but only the read still current when it
 * settles may refill the cache, so one that left before our own mutation
 * never answers a later caller.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  recordOrderMapping: vi.fn(),
  recordOrderMappings: vi.fn(),
}));

vi.mock("@/lib/notify/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/discord")>()),
  sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/brokers/tradovate/penalty", () => ({
  PenaltyResponseHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["assertCircuitClosed"] = vi.fn();
    this["handle"] = vi.fn().mockResolvedValue({ kind: "ok" });
  }),
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  isProductionEnv: vi.fn().mockReturnValue(false),
}));

import { TradovateClient, type TradovateCredentialBundle } from "./client";
import type { PlaceOrderRequest } from "@/lib/brokers/types";

const ACCOUNT_ID = 90035646;
const CONTRACT_ID = 4470324;
const ORDER_LIST_PATH = "/order/list";
const VERSION_PATH_PREFIX = "/orderVersion/ldeps";
const CANCEL_PATH = "/order/cancelOrder";
const MODIFY_PATH = "/order/modifyOrder";
const PLACE_PATH = "/order/placeOrder";
const RESTING_ID = 900;

const CREDENTIALS: TradovateCredentialBundle = {
  username: "u",
  password: "p",
  apiCid: "1",
  apiSecret: "s",
  appId: "a",
  appVersion: "1.0",
  deviceId: "device-1",
};

const MARKET_ORDER: PlaceOrderRequest = {
  accountId: ACCOUNT_ID,
  contractId: "MNQZ6",
  type: 2, // Market
  side: 0, // Buy
  size: 1,
};

function listItem(id: number) {
  return { id, accountId: ACCOUNT_ID, contractId: CONTRACT_ID, ordStatus: "Working", action: "Sell" };
}

const VERSIONS = [{ id: 1, orderId: RESTING_ID, orderType: "Stop", orderQty: 1, stopPrice: 7697.75 }];

type Handler = () => Promise<unknown>;

/**
 * A client whose internal `request` is routed by path. `/order/list` answers
 * from `listReads` in call order (the last one repeats); the version join
 * answers `VERSIONS`; any other path answers from `others`.
 */
function clientWith(
  listReads: Handler[],
  others: Record<string, Handler> = {},
  credentials: TradovateCredentialBundle | null = null,
) {
  const client = new TradovateClient("http://localhost:0", credentials);
  client.setToken("test-token");
  let listCall = 0;
  const request = vi.fn(async (_method: string, path: string) => {
    if (path === ORDER_LIST_PATH) {
      const handler = listReads[Math.min(listCall, listReads.length - 1)];
      listCall += 1;
      return handler();
    }
    if (path.startsWith(VERSION_PATH_PREFIX)) return VERSIONS;
    const other = others[path];
    if (other) return other();
    throw new Error(`unexpected path ${path}`);
  });
  const fields = client as unknown as Record<string, unknown>;
  fields["request"] = request;
  fields["accountSpecCache"] = {
    entries: new Map([[ACCOUNT_ID, "DEMO1"]]),
    expiresAt: Date.now() + 60_000,
  };
  const listReadCount = () => request.mock.calls.filter(([, p]) => p === ORDER_LIST_PATH).length;
  return { client, request, listReadCount };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const answers = (value: unknown): Handler => () => Promise.resolve(value);

describe("TradovateClient open-orders cache — invalidation in a finally", () => {
  it("a cancel that throws after the request was sent still invalidates the cache", async () => {
    const { client, listReadCount } = clientWith([answers([listItem(RESTING_ID)])], {
      [CANCEL_PATH]: () => Promise.reject(new Error("socket hang up")),
    });
    await client.searchOpenOrders(ACCOUNT_ID);

    await expect(client.cancelOrder(RESTING_ID, ACCOUNT_ID)).rejects.toThrow("socket hang up");
    await client.searchOpenOrders(ACCOUNT_ID);

    expect(listReadCount()).toBe(2);
  });

  it("a modify the gateway rejects still invalidates the cache", async () => {
    const { client, listReadCount } = clientWith([answers([listItem(RESTING_ID)])], {
      [MODIFY_PATH]: answers({ failureReason: "UnknownReason" }),
    });
    await client.searchOpenOrders(ACCOUNT_ID);

    await expect(client.modifyOrder(ACCOUNT_ID, RESTING_ID, { stopPrice: 7700 })).rejects.toThrow();
    await client.searchOpenOrders(ACCOUNT_ID);

    expect(listReadCount()).toBe(2);
  });

  it("a place that throws after the request was sent still invalidates the cache", async () => {
    const { client, listReadCount } = clientWith(
      [answers([listItem(RESTING_ID)])],
      { [PLACE_PATH]: () => Promise.reject(new Error("request timeout")) },
      CREDENTIALS,
    );
    await client.searchOpenOrders(ACCOUNT_ID);

    await expect(client.placeOrder(MARKET_ORDER)).rejects.toThrow("request timeout");
    await client.searchOpenOrders(ACCOUNT_ID);

    expect(listReadCount()).toBe(2);
  });

  it("a place refused before it is sent leaves the cache standing", async () => {
    // No credential override and the settings mock answers no deviceId.
    const { client, request, listReadCount } = clientWith([answers([listItem(RESTING_ID)])]);
    await client.searchOpenOrders(ACCOUNT_ID);

    await expect(client.placeOrder(MARKET_ORDER)).rejects.toThrow("deviceId not configured");
    await client.searchOpenOrders(ACCOUNT_ID);

    expect(request.mock.calls.some(([, p]) => p === PLACE_PATH)).toBe(false);
    expect(listReadCount()).toBe(1);
  });
});

describe("TradovateClient open-orders cache — the in-flight read", () => {
  it("a read in flight when a cancel succeeds does not refill the cache", async () => {
    const staleList = deferred<unknown>();
    const { client, listReadCount } = clientWith(
      [() => staleList.promise, answers([])],
      { [CANCEL_PATH]: answers({}) },
    );
    const staleRead = client.searchOpenOrders(ACCOUNT_ID);

    await client.cancelOrder(RESTING_ID, ACCOUNT_ID);
    staleList.resolve([listItem(RESTING_ID)]);
    await staleRead;
    const next = await client.searchOpenOrders(ACCOUNT_ID);

    expect(listReadCount()).toBe(2);
    expect(next).toEqual([]);
  });

  it("a caller arriving after our own cancel does not join a read that left before it", async () => {
    const staleList = deferred<unknown>();
    const { client, listReadCount } = clientWith(
      [() => staleList.promise, answers([])],
      { [CANCEL_PATH]: answers({}) },
    );
    const staleRead = client.searchOpenOrders(ACCOUNT_ID);

    await client.cancelOrder(RESTING_ID, ACCOUNT_ID);
    const after = client.searchOpenOrders(ACCOUNT_ID);
    staleList.resolve([listItem(RESTING_ID)]);
    await staleRead;

    expect(await after).toEqual([]);
    expect(listReadCount()).toBe(2);
  });

  it("a dropped read settling while its successor runs leaves the successor's slot for later callers", async () => {
    const readA = deferred<unknown>();
    const readB = deferred<unknown>();
    const { client, listReadCount } = clientWith(
      [() => readA.promise, () => readB.promise],
      { [CANCEL_PATH]: answers({}) },
    );
    const a = client.searchOpenOrders(ACCOUNT_ID);
    await client.cancelOrder(RESTING_ID, ACCOUNT_ID);
    const b = client.searchOpenOrders(ACCOUNT_ID);

    readA.resolve([listItem(RESTING_ID)]);
    await a;
    const third = client.searchOpenOrders(ACCOUNT_ID, { forceFresh: true });

    expect(listReadCount()).toBe(2);
    readB.resolve([]);
    expect(await third).toBe(await b);
  });

  it("two callers arriving while one read is in flight share it", async () => {
    const list = deferred<unknown>();
    const { client, listReadCount } = clientWith([() => list.promise]);

    const first = client.searchOpenOrders(ACCOUNT_ID);
    const second = client.searchOpenOrders(ACCOUNT_ID, { forceFresh: true });
    list.resolve([listItem(RESTING_ID)]);
    const [a, b] = await Promise.all([first, second]);

    expect(listReadCount()).toBe(1);
    expect(b).toBe(a);
    expect(a.map((o) => o.id)).toEqual([RESTING_ID]);
  });

  it("a caller arriving after the read settled sends its own", async () => {
    const { client, listReadCount } = clientWith([answers([listItem(RESTING_ID)])]);

    await client.searchOpenOrders(ACCOUNT_ID);
    await client.searchOpenOrders(ACCOUNT_ID, { forceFresh: true });

    expect(listReadCount()).toBe(2);
  });
});
