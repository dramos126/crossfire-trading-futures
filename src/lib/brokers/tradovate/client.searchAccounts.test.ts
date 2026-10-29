/**
 * `searchAccounts` is every account fan-out's Tradovate arm, and an arm that
 * resolves is read as the broker's answer: the registry routes by it, the
 * orphan cross-check pauses on what it leaves out, and the status check marks
 * every account it omits inactive. A body that is not a list therefore has to
 * throw — read as `[]` it says "every account is closed" on the strength of a
 * null or an error-shaped 200.
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

// Keeps the circuit breaker out of a controlled response.
vi.mock("@/lib/brokers/tradovate/penalty", () => ({
  PenaltyResponseHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["assertCircuitClosed"] = vi.fn();
    this["handle"] = vi.fn().mockResolvedValue({ kind: "ok" });
  }),
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  isProductionEnv: vi.fn().mockReturnValue(false),
}));

import { TradovateClient } from "./client";

/** A client whose `/account/list` answers `body`. */
function clientAnswering(body: unknown): TradovateClient {
  const client = new TradovateClient("http://localhost:0");
  client.setToken("test-token");
  (client as unknown as Record<string, unknown>)["request"] = vi.fn(async () => body);
  return client;
}

describe("TradovateClient.searchAccounts", () => {
  it("lists the active accounts of a list body", async () => {
    const client = clientAnswering([
      { id: 1, name: "DEMO1", active: true },
      { id: 2, name: "DEMO2", active: false },
    ]);
    const accounts = await client.searchAccounts();
    expect(accounts.map((a) => a.id)).toEqual([1]);
  });

  it("takes an empty list as an answer", async () => {
    await expect(clientAnswering([]).searchAccounts()).resolves.toEqual([]);
  });

  for (const [label, body] of [
    ["null", null],
    ["an error-shaped 200", { errorText: "Access is denied" }],
    ["a string", "Access is denied"],
  ] as const) {
    it(`throws on ${label} rather than reading it as every account closed`, async () => {
      await expect(clientAnswering(body).searchAccounts()).rejects.toThrow("/account/list");
    });
  }
});
