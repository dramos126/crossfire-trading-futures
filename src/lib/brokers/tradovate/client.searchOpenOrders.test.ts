/**
 * `/order/list` carries no orderType, orderQty, price or stopPrice — all
 * four live on the order version (bugs.md, demo-confirmed 2026-10-24), so a
 * translated Tradovate order had an undefined type and null prices and the
 * reconciler and exit sweep saw no bracket. `searchOpenOrders` now joins the
 * current version onto each order before translating. These tests pin the
 * join: a resting stop/limit answers a real type and numeric price, the
 * batch reads the versions once per call (not once per order), and the 1s
 * open-orders cache is honoured.
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

import { TradovateClient } from "./client";

const ACCOUNT_ID = 90035646;
const CONTRACT_ID = 4470324;
const ORDER_LIST_PATH = "/order/list";
const VERSION_PATH_PREFIX = "/orderVersion/ldeps";

/** A `/order/list` item: no orderType, orderQty, price or stopPrice. */
function listItem(id: number, action: "Buy" | "Sell" = "Sell") {
  return {
    id,
    accountId: ACCOUNT_ID,
    contractId: CONTRACT_ID,
    ordStatus: "Working",
    action,
  };
}

/**
 * A client whose internal `request` is routed by path. `/order/list` returns
 * `list`; a `/orderVersion/ldeps…` call returns `versions`. Returns the spy
 * so call counts can be asserted.
 */
function clientWith(list: unknown[], versions: unknown[]): {
  client: TradovateClient;
  request: ReturnType<typeof vi.fn>;
} {
  const client = new TradovateClient("http://localhost:0");
  client.setToken("test-token");
  const request = vi.fn(async (_method: string, path: string) => {
    if (path === ORDER_LIST_PATH) return list;
    if (path.startsWith(VERSION_PATH_PREFIX)) return versions;
    throw new Error(`unexpected path ${path}`);
  });
  (client as unknown as Record<string, unknown>)["request"] = request;
  return { client, request };
}

describe("TradovateClient.searchOpenOrders — order-version join", () => {
  it("a resting stop answers type 4 (Stop) and the version's numeric stopPrice", async () => {
    const { client } = clientWith(
      [listItem(900)],
      [{ id: 1, orderId: 900, orderType: "Stop", orderQty: 1, stopPrice: 7697.75 }],
    );

    const [sl] = await client.searchOpenOrders(ACCOUNT_ID);

    expect(sl.type).toBe(4);
    expect(sl.stopPrice).toBe(7697.75);
    expect(sl.size).toBe(1);
  });

  it("a resting limit answers type 1 (Limit) and the version's numeric price", async () => {
    const { client } = clientWith(
      [listItem(901)],
      [{ id: 1, orderId: 901, orderType: "Limit", orderQty: 2, price: 7710.25 }],
    );

    const [tp] = await client.searchOpenOrders(ACCOUNT_ID);

    expect(tp.type).toBe(1);
    expect(tp.limitPrice).toBe(7710.25);
    expect(tp.size).toBe(2);
  });

  it("reads the versions once per call, not once per order", async () => {
    const { client, request } = clientWith(
      [listItem(900), listItem(901)],
      [
        { id: 1, orderId: 900, orderType: "Stop", orderQty: 1, stopPrice: 7697.75 },
        { id: 1, orderId: 901, orderType: "Limit", orderQty: 1, price: 7710.25 },
      ],
    );

    await client.searchOpenOrders(ACCOUNT_ID);

    const versionReads = request.mock.calls.filter(([, path]) =>
      String(path).startsWith(VERSION_PATH_PREFIX),
    );
    expect(versionReads).toHaveLength(1);
    // And it asked for both order ids in the one batch.
    expect(String(versionReads[0][1])).toContain("900");
    expect(String(versionReads[0][1])).toContain("901");
  });

  it("the latest version per order wins — highest version id", async () => {
    const { client } = clientWith(
      [listItem(900)],
      [
        { id: 10, orderId: 900, orderType: "Stop", orderQty: 1, stopPrice: 7697.75 },
        { id: 12, orderId: 900, orderType: "Stop", orderQty: 1, stopPrice: 7701.0 },
        { id: 11, orderId: 900, orderType: "Stop", orderQty: 1, stopPrice: 7699.5 },
      ],
    );

    const [sl] = await client.searchOpenOrders(ACCOUNT_ID);

    expect(sl.stopPrice).toBe(7701.0);
  });

  it("honours the 1s cache — a second call in the window re-reads neither list nor versions", async () => {
    const { client, request } = clientWith(
      [listItem(900)],
      [{ id: 1, orderId: 900, orderType: "Stop", orderQty: 1, stopPrice: 7697.75 }],
    );

    await client.searchOpenOrders(ACCOUNT_ID);
    await client.searchOpenOrders(ACCOUNT_ID);

    expect(request.mock.calls.filter(([, p]) => p === ORDER_LIST_PATH)).toHaveLength(1);
    expect(
      request.mock.calls.filter(([, p]) => String(p).startsWith(VERSION_PATH_PREFIX)),
    ).toHaveLength(1);
  });

  it("an empty order list reads no versions — no ldeps call", async () => {
    const { client, request } = clientWith([], []);

    const orders = await client.searchOpenOrders(ACCOUNT_ID);

    expect(orders).toEqual([]);
    expect(
      request.mock.calls.filter(([, p]) => String(p).startsWith(VERSION_PATH_PREFIX)),
    ).toHaveLength(0);
  });

  it("a failed version read leaves the order translatable — type degrades to Stop, not undefined", async () => {
    const client = new TradovateClient("http://localhost:0");
    client.setToken("test-token");
    (client as unknown as Record<string, unknown>)["request"] = vi.fn(
      async (_method: string, path: string) => {
        if (path === ORDER_LIST_PATH) return [listItem(900)];
        if (path.startsWith(VERSION_PATH_PREFIX)) throw new Error("gateway down");
        throw new Error(`unexpected path ${path}`);
      },
    );

    const [sl] = await client.searchOpenOrders(ACCOUNT_ID);

    expect(sl.type).toBe(4);
    expect(sl.stopPrice).toBeNull();
  });
});
