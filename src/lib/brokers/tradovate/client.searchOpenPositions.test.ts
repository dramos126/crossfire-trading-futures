/**
 * `searchOpenPositions` feeds the ghost sweep, the pre-entry conflict check
 * and `/api/positions`, and every one of them matches on the dated symbol the
 * trade row holds. A position keyed by its stringified numeric id matches
 * nothing: the sweep reads it as a ghost (A72) and the account chip reads
 * FLAT over an open trade (A68).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

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

import { CONTRACT_WARM_FAILURE_TTL_MS, POSITION_WARM_WAIT_MS, TradovateClient } from "./client";

const ACCOUNT_ID = 90035646;
// The id A72 quotes from the reviewer's trace.
const NUMERIC_CONTRACT_ID = 4470324;
const DATED_SYMBOL = "MNQZ6";
const POSITION_LIST_PATH = "/position/list";
const CONTRACT_ITEM_PATH = `/contract/item?id=${NUMERIC_CONTRACT_ID}`;

/** A client whose gateway answers by path; returns the request spy. */
function clientWith(routes: Record<string, () => unknown>): {
  client: TradovateClient;
  request: ReturnType<typeof vi.fn>;
} {
  const client = new TradovateClient("http://localhost:0");
  client.setToken("test-token");
  const request = vi.fn(async (_method: string, path: string) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected path ${path}`);
    return route();
  });
  (client as unknown as Record<string, unknown>)["request"] = request;
  return { client, request };
}

const openLong = () => [
  { id: 1, accountId: ACCOUNT_ID, contractId: NUMERIC_CONTRACT_ID, netPos: 1, netPrice: 21000 },
];

describe("TradovateClient.searchOpenPositions on a cold dated-symbol cache", () => {
  it("A72/A68: keys a position by its dated symbol, warming the cache first, not by the stringified numeric id", async () => {
    const { client } = clientWith({
      [POSITION_LIST_PATH]: openLong,
      [CONTRACT_ITEM_PATH]: () => ({ id: NUMERIC_CONTRACT_ID, name: DATED_SYMBOL }),
    });

    const positions = await client.searchOpenPositions(ACCOUNT_ID);

    expect(positions.map((p) => p.contractId)).toEqual([DATED_SYMBOL]);
  });

  it("warms each contract once per process — a warm cache costs no extra round trip", async () => {
    const { client, request } = clientWith({
      [POSITION_LIST_PATH]: openLong,
      [CONTRACT_ITEM_PATH]: () => ({ id: NUMERIC_CONTRACT_ID, name: DATED_SYMBOL }),
    });

    await client.searchOpenPositions(ACCOUNT_ID);
    await client.searchOpenPositions(ACCOUNT_ID);

    const warms = request.mock.calls.filter(([, path]) => path === CONTRACT_ITEM_PATH);
    expect(warms).toHaveLength(1);
  });

  it("still answers, on the numeric id, when the warm cannot name the contract", async () => {
    const { client } = clientWith({
      [POSITION_LIST_PATH]: openLong,
      [CONTRACT_ITEM_PATH]: () => {
        throw new Error("fetch failed");
      },
    });

    const positions = await client.searchOpenPositions(ACCOUNT_ID);

    // A position the broker reports is never withheld for want of a name.
    expect(positions.map((p) => p.contractId)).toEqual([String(NUMERIC_CONTRACT_ID)]);
  });
});

/**
 * The watchdog, force-flat, the manual-position flatten, the reconciler and
 * flatten-all all read through here. A `/contract/item` that hangs or fails
 * while `/position/list` works must not stall each of them for the request
 * timeout on every call.
 */
describe("TradovateClient.searchOpenPositions when /contract/item is unhealthy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not ask /contract/item again for an id it failed to name, until the failure ages out", async () => {
    vi.useFakeTimers();
    const { client, request } = clientWith({
      [POSITION_LIST_PATH]: openLong,
      [CONTRACT_ITEM_PATH]: () => {
        throw new Error("fetch failed");
      },
    });
    const warms = () => request.mock.calls.filter(([, path]) => path === CONTRACT_ITEM_PATH).length;

    await client.searchOpenPositions(ACCOUNT_ID);
    await client.searchOpenPositions(ACCOUNT_ID);
    expect(warms()).toBe(1);

    vi.advanceTimersByTime(CONTRACT_WARM_FAILURE_TTL_MS);
    await client.searchOpenPositions(ACCOUNT_ID);
    expect(warms()).toBe(2);
  });

  it("answers within the bounded wait on a hanging warm, on the numeric id", async () => {
    vi.useFakeTimers();
    const { client } = clientWith({
      [POSITION_LIST_PATH]: openLong,
      [CONTRACT_ITEM_PATH]: () => new Promise(() => {}),
    });

    let answered: string[] | null = null;
    void client.searchOpenPositions(ACCOUNT_ID).then((ps) => {
      answered = ps.map((p) => p.contractId);
    });
    await vi.advanceTimersByTimeAsync(POSITION_WARM_WAIT_MS - 1);
    expect(answered).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toEqual([String(NUMERIC_CONTRACT_ID)]);
  });
});
