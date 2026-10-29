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
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  recordOrderMapping: vi.fn(),
  recordOrderMappings: vi.fn(),
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

// Stub the penalty module so no Discord calls escape into tests and so the
// circuit-breaker never fires on our controlled fetch responses.
vi.mock("@/lib/brokers/tradovate/penalty", () => ({
  PenaltyResponseHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["assertCircuitClosed"] = vi.fn();
    this["handle"] = vi.fn().mockResolvedValue({ kind: "ok" });
  }),
}));

vi.mock("@/lib/env", () => ({
  isProductionEnv: vi.fn().mockReturnValue(false),
}));

import { TradovateClient } from "./client";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a TradovateClient that already has a token (bypasses needsRefresh →
 * validateSession), then replace `request` (protected) with a spy that
 * returns the provided per-call responses in order.
 */
function makeClientWithResponses(...responses: unknown[]): TradovateClient {
  const client = new TradovateClient("http://localhost:0");
  client.setToken("test-token");

  let callIndex = 0;
  // Overwrite the protected `request` method directly on the instance.
  (client as unknown as Record<string, unknown>)["request"] = vi.fn(
    async () => responses[callIndex++],
  );

  return client;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TradovateClient.getContractSpec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: two-hop resolution returns { tickSize, tickValue }", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const groupItem = { id: 77, name: "MES", tickSize: 0.25, valuePerPoint: 5 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(12345);

    expect(result).not.toBeNull();
    expect(result!.tickSize).toBe(0.25);
    // tickValue = valuePerPoint * tickSize = 5 * 0.25 = 1.25
    expect(result!.tickValue).toBeCloseTo(1.25, 10);
  });

  it("MNQ example: valuePerPoint=5, tickSize=0.25 → tickValue=1.25", async () => {
    // MNQ contract group: $5/point, tick=0.25 → $1.25/tick
    const contractItem = { id: 99999, name: "MNQU5", contractGroupId: 42 };
    const groupItem = { id: 42, name: "MNQ", tickSize: 0.25, valuePerPoint: 5 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(99999);

    expect(result).not.toBeNull();
    expect(result!.tickSize).toBe(0.25);
    expect(result!.tickValue).toBeCloseTo(1.25, 10);
  });

  it("ES example: valuePerPoint=50, tickSize=0.25 → tickValue=12.5", async () => {
    const contractItem = { id: 11111, name: "ESU5", contractGroupId: 10 };
    const groupItem = { id: 10, name: "ES", tickSize: 0.25, valuePerPoint: 50 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(11111);

    expect(result).not.toBeNull();
    expect(result!.tickValue).toBeCloseTo(12.5, 10);
  });

  it("/contract/item returns null → returns null", async () => {
    const client = makeClientWithResponses(null);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("/contract/item returns non-object (string) → returns null", async () => {
    const client = makeClientWithResponses("bad response");

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("missing contractGroupId → returns null without calling contractGroup endpoint", async () => {
    // contractGroupId absent — the second hop must never be issued.
    const contractItem = { id: 12345, name: "MESU5" };
    const client = makeClientWithResponses(contractItem);
    const requestSpy = (client as unknown as Record<string, unknown>)["request"] as ReturnType<typeof vi.fn>;

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
    // Only the /contract/item call should have been made.
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("contractGroupId present but non-numeric (string) → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: "not-a-number" };
    const client = makeClientWithResponses(contractItem);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("/contractGroup/item returns null → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const client = makeClientWithResponses(contractItem, null);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("/contractGroup/item returns non-object (array) → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const client = makeClientWithResponses(contractItem, []);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("tickSize === 0 → returns null (division-by-zero guard)", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const groupItem = { id: 77, tickSize: 0, valuePerPoint: 5 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("tickSize negative → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const groupItem = { id: 77, tickSize: -0.25, valuePerPoint: 5 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("valuePerPoint === 0 → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const groupItem = { id: 77, tickSize: 0.25, valuePerPoint: 0 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("valuePerPoint negative → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const groupItem = { id: 77, tickSize: 0.25, valuePerPoint: -5 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("tickSize present but non-numeric in group response → returns null", async () => {
    const contractItem = { id: 12345, name: "MESU5", contractGroupId: 77 };
    const groupItem = { id: 77, tickSize: "0.25", valuePerPoint: 5 };
    const client = makeClientWithResponses(contractItem, groupItem);

    const result = await client.getContractSpec(12345);

    expect(result).toBeNull();
  });

  it("makes exactly two request() calls on the happy path", async () => {
    const contractItem = { id: 12345, contractGroupId: 77 };
    const groupItem = { tickSize: 0.25, valuePerPoint: 5 };
    const client = makeClientWithResponses(contractItem, groupItem);
    const requestSpy = (client as unknown as Record<string, unknown>)["request"] as ReturnType<typeof vi.fn>;

    await client.getContractSpec(12345);

    expect(requestSpy).toHaveBeenCalledTimes(2);
    // First call targets /contract/item
    expect((requestSpy.mock.calls[0] as unknown[])[1]).toMatch(/\/contract\/item/);
    // Second call targets /contractGroup/item
    expect((requestSpy.mock.calls[1] as unknown[])[1]).toMatch(/\/contractGroup\/item/);
  });
});
