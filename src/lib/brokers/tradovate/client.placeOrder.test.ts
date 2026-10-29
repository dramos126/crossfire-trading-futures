/**
 * Unit tests for TradovateClient.placeOrder — focused on the qty column fix:
 * recordOrderMappings is called with qty=order.size for OSO brackets, and
 * recordOrderMapping is called with qty=order.size for non-OSO orders.
 *
 * Uses the same pattern as client.getContractSpec.test.ts: real TradovateClient
 * with the internal `request` method stubbed so no network calls escape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks (hoisted before any import) ──────────────────────────

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
  getTradovateDeviceId: vi.fn().mockReturnValue("test-device-id"),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
}));

const mockRecordOrderMapping = vi.fn();
const mockRecordOrderMappings = vi.fn();

vi.mock("@/lib/db/tradovate-order-map", () => ({
  recordOrderMapping: (...args: unknown[]) => mockRecordOrderMapping(...args),
  recordOrderMappings: (...args: unknown[]) => mockRecordOrderMappings(...args),
}));

vi.mock("@/lib/notify/discord", () => ({
  sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
  sendOrphanAlert: vi.fn().mockResolvedValue(undefined),
  formatNyTime: vi.fn().mockReturnValue(""),
  formatAccountLabel: vi.fn().mockReturnValue(""),
  COLOR_ENTRY_LONG: 0,
  COLOR_ENTRY_SHORT: 0,
  COLOR_EXIT_WIN: 0,
  COLOR_EXIT_LOSS: 0,
  COLOR_EXIT_FLAT: 0,
  COLOR_EXIT_BE: 0,
  COLOR_EXIT_TRAIL: 0,
  COLOR_EXIT_STRATEGY: 0,
  COLOR_EXIT_MANUAL: 0,
  COLOR_BRACKET_FAILURE: 0,
  COLOR_CONNECTION_LOST: 0,
  COLOR_CONNECTION_RESTORED: 0,
  ansiGreen: (s: string) => s,
  ansiRed: (s: string) => s,
  ansiBlue: (s: string) => s,
  ansiGray: (s: string) => s,
  ANSI_LINE_WIDTH: 80,
  padAnsiLine: (s: string) => s,
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

vi.mock("@/lib/brokers/tradovate/penalty", () => ({
  PenaltyResponseHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["assertCircuitClosed"] = vi.fn();
    this["handle"] = vi.fn().mockResolvedValue({ kind: "ok" });
  }),
}));

vi.mock("@/lib/env", () => ({
  isProductionEnv: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { TradovateClient } from "./client";
import { TradovateAccountNotActiveError, TradovateOrderRejectionError } from "./errors";
import { BrokerOrderRole } from "@/lib/trading/orders/order-role";
import type { PlaceOrderRequest } from "@/lib/brokers/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a client with a live token and a pre-seeded accountSpec cache so
 * resolveAccountSpec doesn't try to hit /account/list. Stubs `request` to
 * return responses in order.
 */
function makeClientWithResponses(...responses: unknown[]): TradovateClient {
  const client = new TradovateClient("http://localhost:0");
  client.setToken("test-token");

  // Seed the accountSpec cache to bypass the /account/list fetch inside
  // resolveAccountSpec. The cache is private; inject via casting.
  (client as unknown as Record<string, unknown>)["accountSpecCache"] = {
    entries: new Map([[2001, "DEMO99999"]]),
    expiresAt: Date.now() + 300_000,
  };

  let callIndex = 0;
  (client as unknown as Record<string, unknown>)["request"] = vi.fn(
    async () => responses[callIndex++],
  );

  return client;
}

function makeOsoRequest(overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return {
    accountId: 2001,
    deploymentId: "deploy-aaa",
    contractId: "MNQM6",
    side: 0,           // long entry
    size: 2,
    type: 2,           // Market
    brokerOrderRole: BrokerOrderRole.Entry,
    // Signed offsets from entry (21000): SL must be below (negative), TP above (positive).
    stopLossBracket: { ticks: -16, type: 4 },
    takeProfitBracket: { ticks: 32, type: 1 },
    referencePrice: 21000,
    tickSize: 0.25,
    ...overrides,
  };
}

function makeNonOsoRequest(overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return {
    accountId: 2001,
    deploymentId: "deploy-bbb",
    contractId: "MNQM6",
    side: 1,
    size: 2,
    type: 2,           // Market
    brokerOrderRole: BrokerOrderRole.Exit,
    tickSize: 0.25,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRecordOrderMapping.mockReset();
  mockRecordOrderMappings.mockReset();
});

describe("TradovateClient.placeOrder — OSO path qty recording", () => {
  it("calls recordOrderMappings with qty=order.size for the entry leg", async () => {
    // OSO success response: orderId for entry, oso1Id for SL, oso2Id for TP.
    const client = makeClientWithResponses({ orderId: 1001, oso1Id: 1002, oso2Id: 1003 });

    await client.placeOrder(makeOsoRequest({ size: 2 }));

    expect(mockRecordOrderMappings).toHaveBeenCalledTimes(1);
    const rows: Array<{ orderId: number; role: string; qty: number }> =
      mockRecordOrderMappings.mock.calls[0][0];

    const entry = rows.find((r) => r.orderId === 1001);
    expect(entry?.qty).toBe(2);
  });

  it("SL row (oso1Id) has qty=order.size — the fix for size-2 bracket counted as coverage=1", async () => {
    // Regression: before the fix, the watchdog read order.orderQty ?? 1 from
    // the live order response. /order/item often omits orderQty, making a 2-lot
    // SL count as coverage=1. The fix: record qty at place time and use m.qty.
    const client = makeClientWithResponses({ orderId: 1001, oso1Id: 1002, oso2Id: 1003 });

    await client.placeOrder(makeOsoRequest({ size: 2 }));

    const rows: Array<{ orderId: number; role: string; qty: number }> =
      mockRecordOrderMappings.mock.calls[0][0];

    const sl = rows.find((r) => r.orderId === 1002);
    expect(sl?.role).toBe("sl");
    expect(sl?.qty).toBe(2);
  });

  it("TP row (oso2Id) has qty=order.size", async () => {
    const client = makeClientWithResponses({ orderId: 1001, oso1Id: 1002, oso2Id: 1003 });

    await client.placeOrder(makeOsoRequest({ size: 3 }));

    const rows: Array<{ orderId: number; role: string; qty: number }> =
      mockRecordOrderMappings.mock.calls[0][0];

    const tp = rows.find((r) => r.orderId === 1003);
    expect(tp?.role).toBe("tp");
    expect(tp?.qty).toBe(3);
  });

  it("omits SL row when oso1Id is absent from response", async () => {
    // Tradovate may omit bracket ids when the bracket wasn't placed (error path or
    // a non-bracketed response leaking into the OSO codepath). The row array must
    // not include a row for a missing id.
    const client = makeClientWithResponses({ orderId: 1001, oso2Id: 1003 });

    await client.placeOrder(makeOsoRequest({ size: 2 }));

    const rows: Array<{ orderId: number; role: string; qty: number }> =
      mockRecordOrderMappings.mock.calls[0][0];

    expect(rows.find((r) => r.role === "sl")).toBeUndefined();
    expect(rows.find((r) => r.role === "tp")).toBeDefined();
  });

  it("omits TP row when oso2Id is absent from response", async () => {
    const client = makeClientWithResponses({ orderId: 1001, oso1Id: 1002 });

    await client.placeOrder(makeOsoRequest({ size: 2 }));

    const rows: Array<{ orderId: number; role: string; qty: number }> =
      mockRecordOrderMappings.mock.calls[0][0];

    expect(rows.find((r) => r.role === "tp")).toBeUndefined();
    expect(rows.find((r) => r.role === "sl")).toBeDefined();
  });

  it("does NOT call recordOrderMappings when deploymentId is absent", async () => {
    const client = makeClientWithResponses({ orderId: 1001, oso1Id: 1002, oso2Id: 1003 });

    await client.placeOrder(makeOsoRequest({ deploymentId: undefined }));

    expect(mockRecordOrderMappings).not.toHaveBeenCalled();
  });

  it("does NOT call recordOrderMappings when deploymentId is empty string", async () => {
    const client = makeClientWithResponses({ orderId: 1001, oso1Id: 1002, oso2Id: 1003 });

    await client.placeOrder(makeOsoRequest({ deploymentId: "" }));

    expect(mockRecordOrderMappings).not.toHaveBeenCalled();
  });
});

describe("TradovateClient.placeOrder — non-OSO path qty recording", () => {
  it("calls recordOrderMapping (singular) with qty=order.size", async () => {
    // Non-OSO (no brackets): /order/placeOrder response shape — no oso* fields.
    const client = makeClientWithResponses({ orderId: 2001 });

    await client.placeOrder(makeNonOsoRequest({ size: 2 }));

    expect(mockRecordOrderMapping).toHaveBeenCalledTimes(1);
    const arg: { orderId: number; role: string; qty: number } =
      mockRecordOrderMapping.mock.calls[0][0];

    expect(arg.orderId).toBe(2001);
    expect(arg.qty).toBe(2);
  });

  it("role is 'exit' when brokerOrderRole is Exit", async () => {
    const client = makeClientWithResponses({ orderId: 2001 });

    await client.placeOrder(makeNonOsoRequest({ brokerOrderRole: BrokerOrderRole.Exit }));

    const arg: { role: string } = mockRecordOrderMapping.mock.calls[0][0];
    expect(arg.role).toBe("exit");
  });

  it("role is 'entry' when brokerOrderRole is Entry", async () => {
    const client = makeClientWithResponses({ orderId: 2001 });

    await client.placeOrder(
      makeNonOsoRequest({ brokerOrderRole: BrokerOrderRole.Entry, size: 1 }),
    );

    const arg: { role: string } = mockRecordOrderMapping.mock.calls[0][0];
    expect(arg.role).toBe("entry");
  });

  it("size=1 records qty=1 (single-contract base case)", async () => {
    const client = makeClientWithResponses({ orderId: 2001 });

    await client.placeOrder(makeNonOsoRequest({ size: 1 }));

    const arg: { qty: number } = mockRecordOrderMapping.mock.calls[0][0];
    expect(arg.qty).toBe(1);
  });

  it("does NOT call recordOrderMapping when deploymentId is absent", async () => {
    const client = makeClientWithResponses({ orderId: 2001 });

    await client.placeOrder(makeNonOsoRequest({ deploymentId: undefined }));

    expect(mockRecordOrderMapping).not.toHaveBeenCalled();
  });
});

/**
 * Only a documented risk or account refusal is the typed rejection, because
 * the plugin classifies that class `order_rejected` and the watchdog then
 * releases its double-flatten stamp (A37). A value that does not say the
 * order was refused stays a plain, unowned `Error`. Values are Tradovate's
 * documented place-order `failureReason` enum
 * (docs.ninjatrader.com/api/rest-api-endpoints/orders/place-order).
 */
describe("TradovateClient.placeOrder — which failureReason is a refusal", () => {
  it("failureReason Success with an orderId is an accepted order, not a throw", async () => {
    const client = makeClientWithResponses({ failureReason: "Success", orderId: 2001 });

    await expect(client.placeOrder(makeNonOsoRequest())).resolves.toMatchObject({ orderId: 2001 });
    expect(mockRecordOrderMapping).toHaveBeenCalledTimes(1);
  });

  it.each(["RiskCheckTimeout", "UnknownReason", "OtherExecutionRelated", "ExecutionProviderUnavailable", "AnotherCommandPending"])(
    "%s is a plain Error carrying the reason, not the typed refusal",
    async (reason) => {
      const client = makeClientWithResponses({ failureReason: reason, failureText: "detail" });

      const err = await client.placeOrder(makeNonOsoRequest()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TradovateOrderRejectionError);
      expect((err as Error).message).toContain(reason);
      expect((err as Error).message).toContain("detail");
    },
  );

  it.each(["MaxPosLimitReached", "TradingLocked", "AccountClosed", "LiquidationOnly"])(
    "%s stays the typed refusal",
    async (reason) => {
      const client = makeClientWithResponses({ failureReason: reason });

      const err = await client.placeOrder(makeNonOsoRequest()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TradovateOrderRejectionError);
      expect((err as TradovateOrderRejectionError).failureReason).toBe(reason);
    },
  );

  it("AccountNotActive keeps its own class", async () => {
    const client = makeClientWithResponses({ failureReason: "AccountNotActive" });

    await expect(client.placeOrder(makeNonOsoRequest())).rejects.toBeInstanceOf(TradovateAccountNotActiveError);
  });
});
