import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Module-level mocks ────────────────────────────────────────────────────────
// vi.mock calls are hoisted — factory bodies must be self-contained.

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
  getTopstepApiKey: vi.fn().mockReturnValue(null),
  getTopstepUsername: vi.fn().mockReturnValue(null),
  getTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  getNotificationsEnabled: vi.fn().mockReturnValue(false),
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

vi.mock("@/lib/env", () => ({
  isProductionEnv: vi.fn().mockReturnValue(false),
  isStagingEnv: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/db/deployments", () => ({
  listManagedDeployments: vi.fn().mockReturnValue([]),
  // Remaining exports used by dependency chain:
  getDeployment: vi.fn().mockReturnValue(null),
  listDeployments: vi.fn().mockReturnValue([]),
  markOrphanedByAccount: vi.fn().mockReturnValue([]),
  insertDeployment: vi.fn(),
  updateDeployment: vi.fn(),
  softDeleteDeployment: vi.fn(),
  deleteDeployment: vi.fn(),
  findConflictingDeployments: vi.fn().mockReturnValue([]),
  findConflictingDeployment: vi.fn().mockReturnValue(null),
  filterMainSessionOverlaps: vi.fn().mockReturnValue([]),
  readMainSession: vi.fn().mockReturnValue(null),
  readPauseWindows: vi.fn().mockReturnValue([]),
  listDeletedDeployments: vi.fn().mockReturnValue([]),
  getTombstones: vi.fn().mockReturnValue([]),
  listGroupLegs: vi.fn().mockReturnValue([]),
  markOrphaned: vi.fn().mockReturnValue(false),
  clearOrphaned: vi.fn(),
  runPendingSessionMigrations: vi.fn(),
  listPendingReconciliationDeployments: vi.fn().mockReturnValue([]),
  findCrossStrategyDeployments: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/engine/engine", () => ({
  buildCustomTag: vi.fn((prefix: string, id: string) => `${prefix}_${id.slice(0, 8)}_ts_rand`),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getTradovateClientIfConfigured: vi.fn().mockResolvedValue(null),
  getEngineIfReady: vi.fn().mockReturnValue(null),
}));

// TopstepClient mock — methods set per-test via mockImplementation in beforeEach
vi.mock("@/lib/brokers/topstep/client", () => ({
  TopstepClient: vi.fn(),
}));

vi.mock("@/lib/brokers/topstep/browser-token", () => ({
  topstepBrowserToken: vi.fn().mockResolvedValue("topstep-jwt"),
}));

// ── Imports (after vi.mock hoisting) ─────────────────────────────────────────

import { POST } from "./route";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { isProductionEnv } from "@/lib/env";
import { getEngineIfReady, getTradovateClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import { log } from "@/lib/logger";
import { EngineUnreachableError } from "@/lib/trading/engine/handle/remote";
import { flattenAllResultLabel, toFlattenAllSummary } from "@/components/flatten-all-button";
import type { Account, Position, Order, PlaceOrderRequest } from "@/lib/brokers/types";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(opts: { token?: string }): NextRequest {
  const url = "http://localhost/api/deployments/flatten-all";
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["x-session-token"] = opts.token;
  return new NextRequest(url, { method: "POST", headers });
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1001,
    name: "ACCT-1001",
    balance: 10000,
    canTrade: true,
    isVisible: true,
    broker: "topstep",
    practice: false,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 1,
    accountId: 1001,
    contractId: "CON.F.US.MNQ.M26",
    creationTimestamp: "2026-05-13T14:00:00Z",
    type: 1, // long
    size: 2,
    averagePrice: 21000,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 50001,
    accountId: 1001,
    contractId: "CON.F.US.MNQ.M26",
    creationTimestamp: "2026-05-13T14:00:00Z",
    updateTimestamp: "2026-05-13T14:00:00Z",
    status: 1, // working
    type: 4, // stop
    side: 1,
    size: 1,
    limitPrice: null,
    stopPrice: 20990,
    filledPrice: null,
    ...overrides,
  };
}

/**
 * Build a minimal broker mock. Most methods accept per-test impl overrides
 * so individual tests can exercise specific failure modes.
 */
function makeBrokerMock(opts: {
  accounts?: Account[];
  positions?: Position[];
  openOrders?: Order[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  placeOrderImpl?: (order: PlaceOrderRequest) => Promise<any>;
  searchAccountsImpl?: () => Promise<Account[]>;
  searchOpenPositionsImpl?: (accountId: number) => Promise<Position[]>;
  searchOpenOrdersImpl?: (
    accountId: number,
    opts?: { forceFresh?: boolean },
  ) => Promise<Order[]>;
  cancelOrderImpl?: (orderId: number, accountId: number) => Promise<void>;
}): {
  searchAccounts: ReturnType<typeof vi.fn>;
  searchOpenPositions: ReturnType<typeof vi.fn>;
  placeOrder: ReturnType<typeof vi.fn>;
  searchOpenOrders: ReturnType<typeof vi.fn>;
  searchTrades: ReturnType<typeof vi.fn>;
  getFillsForOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  modifyOrder: ReturnType<typeof vi.fn>;
  invalidateOpenOrders: ReturnType<typeof vi.fn>;
  setToken: ReturnType<typeof vi.fn>;
} {
  const accounts = opts.accounts ?? [];
  const positions = opts.positions ?? [];
  const openOrders = opts.openOrders ?? [];
  return {
    setToken: vi.fn(),
    searchAccounts: opts.searchAccountsImpl
      ? vi.fn(opts.searchAccountsImpl)
      : vi.fn().mockResolvedValue(accounts),
    searchOpenPositions: opts.searchOpenPositionsImpl
      ? vi.fn(opts.searchOpenPositionsImpl)
      : vi.fn().mockResolvedValue(positions),
    placeOrder: opts.placeOrderImpl
      ? vi.fn(opts.placeOrderImpl)
      : vi.fn().mockResolvedValue({ orderId: 9999 }),
    searchOpenOrders: opts.searchOpenOrdersImpl
      ? vi.fn(opts.searchOpenOrdersImpl)
      : vi.fn().mockResolvedValue(openOrders),
    searchTrades: vi.fn().mockResolvedValue([]),
    getFillsForOrder: vi.fn().mockResolvedValue([]),
    cancelOrder: opts.cancelOrderImpl
      ? vi.fn(opts.cancelOrderImpl)
      : vi.fn().mockResolvedValue(undefined),
    modifyOrder: vi.fn().mockResolvedValue(undefined),
    invalidateOpenOrders: vi.fn(),
  };
}

/** Wire a broker mock as the TopstepClient constructor return value. */
function wireTopstepClient(mock: ReturnType<typeof makeBrokerMock>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(TopstepClient).mockImplementation(function (this: any) {
    Object.assign(this, mock);
  });
}

/**
 * Augment a broker mock with Tradovate-only methods the route reaches for
 * (warmContractId, getDatedSymbolForContractId), and register it as the
 * resolved value of getTradovateClientIfConfigured.
 */
function wireTradovateClient(
  brokerMock: ReturnType<typeof makeBrokerMock>,
  opts: {
    warmImpl?: (id: number) => Promise<void>;
    datedSymbolLookup?: (id: number) => string | null;
  } = {},
) {
  const warmContractId = vi.fn(opts.warmImpl ?? (() => Promise.resolve()));
  const getDatedSymbolForContractId = vi.fn(
    opts.datedSymbolLookup ?? ((_id: number) => "MNQM26"),
  );
  const augmented = Object.assign(brokerMock, {
    warmContractId,
    getDatedSymbolForContractId,
  });
  vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(
    augmented as unknown as TradovateClient,
  );
  return augmented;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/deployments/flatten-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isProductionEnv).mockReturnValue(false);
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);
    vi.mocked(topstepBrowserToken).mockResolvedValue("topstep-jwt");

    // Default TopstepClient: no accounts, no positions
    const defaultMock = makeBrokerMock({ accounts: [], positions: [] });
    wireTopstepClient(defaultMock);
  });

  // ── Guard clauses ────────────────────────────────────────────────────────────

  describe("guard clauses", () => {
    it("returns 401 when x-session-token header is missing", async () => {
      const req = makeRequest({});
      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ error: expect.stringContaining("token") });
    });

    it("does not call searchAccounts when token is missing", async () => {
      const req = makeRequest({});
      await POST(req);
      expect(TopstepClient).not.toHaveBeenCalled();
    });
  });

  // ── Env filtering ────────────────────────────────────────────────────────────

  describe("env account filtering", () => {
    it("prod env: practice accounts are skipped, live accounts are included", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(true);

      const liveAccount = makeAccount({ id: 1001, name: "EVAL-1001", practice: false });
      const practiceAccount = makeAccount({ id: 2001, name: "PRAC-2001", practice: true });
      const mock = makeBrokerMock({
        accounts: [liveAccount, practiceAccount],
        positions: [],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok-live" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.env).toBe("prod");
      expect(body.isProd).toBe(true);

      const skipped = body.results.filter((r: { status: string }) => r.status === "skipped");
      const skippedIds = skipped.map((r: { accountId: number }) => r.accountId);
      expect(skippedIds).toContain(2001);
      expect(skippedIds).not.toContain(1001);
    });

    it("staging env: live/eval accounts are skipped, practice accounts are included", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);

      const liveAccount = makeAccount({ id: 1001, name: "EVAL-1001", practice: false });
      const practiceAccount = makeAccount({ id: 2001, name: "PRAC-2001", practice: true });
      const mock = makeBrokerMock({
        accounts: [liveAccount, practiceAccount],
        positions: [],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok-stg" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.env).toBe("staging");
      expect(body.isProd).toBe(false);

      const skipped = body.results.filter((r: { status: string }) => r.status === "skipped");
      const skippedIds = skipped.map((r: { accountId: number }) => r.accountId);
      expect(skippedIds).toContain(1001);
      expect(skippedIds).not.toContain(2001);
    });

    it("skipped result carries a human-readable reason string", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(true);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [] });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      const body = await res.json();

      const skipped = body.results.find(
        (r: { accountId: number }) => r.accountId === 2001,
      );
      expect(skipped.status).toBe("skipped");
      expect(typeof skipped.reason).toBe("string");
      expect(skipped.reason.length).toBeGreaterThan(0);
    });
  });

  // ── No open positions ────────────────────────────────────────────────────────

  describe("no open positions", () => {
    it("returns attempted: 0 and empty position results when no scoped account has open positions", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [] });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.attempted).toBe(0);
      expect(body.ok).toBe(true);
      // Results may include skipped entries but no position-level results
      const positionResults = body.results.flatMap(
        (r: { positions: unknown[] }) => r.positions,
      );
      expect(positionResults).toHaveLength(0);
    });

    it("holds a SIGTERM's exit for the whole request, and releases it at the end", async () => {
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [] });
      let answerAccounts!: (a: Account[]) => void;
      mock.searchAccounts.mockImplementationOnce(
        () => new Promise<Account[]>((r) => (answerAccounts = r)),
      );
      wireTopstepClient(mock);

      const pending = POST(makeRequest({ token: "tok" }));
      await vi.waitFor(() => expect(mock.searchAccounts).toHaveBeenCalled());
      expect(orderRequestsInFlight()).toBe(1);

      answerAccounts([practiceAccount]);
      await pending;
      expect(orderRequestsInFlight()).toBe(0);
    });

    it("does not call placeOrder when there are no positions", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [] });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      await POST(req);

      expect(mock.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ── Market exit order shape ──────────────────────────────────────────────────

  describe("market exit order shape", () => {
    it("issues type:2 (market) order with side:1 (Sell) to close a long position (type:1)", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const longPos = makePosition({ accountId: 2001, type: 1, size: 3 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [longPos],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      await POST(req);

      expect(mock.placeOrder).toHaveBeenCalledOnce();
      const order = mock.placeOrder.mock.calls[0][0] as PlaceOrderRequest;
      expect(order.type).toBe(2); // market
      expect(order.side).toBe(1); // Sell closes a long
      expect(order.size).toBe(3);
      expect(order.accountId).toBe(2001);
      expect(order.contractId).toBe(longPos.contractId);
    });

    it("issues type:2 (market) order with side:0 (Buy) to close a short position (type:2)", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const shortPos = makePosition({ accountId: 2001, type: 2, size: 1 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [shortPos],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      await POST(req);

      expect(mock.placeOrder).toHaveBeenCalledOnce();
      const order = mock.placeOrder.mock.calls[0][0] as PlaceOrderRequest;
      expect(order.type).toBe(2); // market
      expect(order.side).toBe(0); // Buy closes a short
    });

    it("stamps brokerOrderRole: exit on the order", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001, type: 1 });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [pos] });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      await POST(req);

      const order = mock.placeOrder.mock.calls[0][0] as PlaceOrderRequest & {
        brokerOrderRole?: string;
      };
      expect(order.brokerOrderRole).toBe("exit");
    });

    it("stamps a contractId-derived customTag (no deploymentId) so fills are not misattributed", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);

      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001, type: 1, contractId: "CON.F.US.MNQ.M26" });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [pos] });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      await POST(req);

      const order = mock.placeOrder.mock.calls[0][0] as PlaceOrderRequest & {
        deploymentId?: string;
        customTag?: string;
      };
      // Force-close should NOT misattribute the fill to any deployment.
      expect(order.deploymentId).toBeUndefined();
      // customTag uses buildCustomTag("s", contractId) — engine
      // flattenNakedPosition pattern.
      expect(typeof order.customTag).toBe("string");
      expect(order.customTag!.length).toBeGreaterThan(0);
      expect(order.customTag).toMatch(/^s_/);
    });
  });

  // ── Tradovate numeric-contractId warm guard ──────────────────────────────────

  describe("Tradovate contractId cache warm", () => {
    it("warms numeric Tradovate contractId before placeOrder and proceeds when cache resolves", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const topstepMock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(topstepMock);

      const tvAccount = makeAccount({
        id: 3001,
        name: "TV-Demo",
        practice: true,
        broker: "tradovate",
      });
      const tvPos = makePosition({ accountId: 3001, contractId: "2473534" });
      const tvBroker = makeBrokerMock({
        accounts: [tvAccount],
        positions: [tvPos],
      });
      const tvClient = wireTradovateClient(tvBroker);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(tvClient.warmContractId).toHaveBeenCalledWith(2473534);
      expect(tvBroker.placeOrder).toHaveBeenCalledOnce();
    });

    it("skips the close (no placeOrder) when warm leaves the dated symbol unresolved", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const topstepMock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(topstepMock);

      const tvAccount = makeAccount({
        id: 3001,
        name: "TV-Demo",
        practice: true,
        broker: "tradovate",
      });
      const tvPos = makePosition({ accountId: 3001, contractId: "2473534" });
      const tvBroker = makeBrokerMock({
        accounts: [tvAccount],
        positions: [tvPos],
      });
      wireTradovateClient(tvBroker, { datedSymbolLookup: () => null });

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(tvBroker.placeOrder).not.toHaveBeenCalled();

      const body = await res.json();
      const accountResult = body.results.find(
        (r: { accountId: number }) => r.accountId === 3001,
      );
      const posResult = accountResult.positions[0] as {
        status: string;
        reason: string;
      };
      expect(posResult.status).toBe("skipped");
      expect(posResult.reason).toMatch(/not warmed/);
    });

    it("does not call placeOrder when warmContractId itself rejects", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const topstepMock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(topstepMock);

      const tvAccount = makeAccount({
        id: 3001,
        name: "TV-Demo",
        practice: true,
        broker: "tradovate",
      });
      const tvPos = makePosition({ accountId: 3001, contractId: "2473534" });
      const tvBroker = makeBrokerMock({
        accounts: [tvAccount],
        positions: [tvPos],
      });
      wireTradovateClient(tvBroker, {
        warmImpl: () => Promise.reject(new Error("network down")),
      });

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(tvBroker.placeOrder).not.toHaveBeenCalled();

      const body = await res.json();
      const accountResult = body.results.find(
        (r: { accountId: number }) => r.accountId === 3001,
      );
      const posResult = accountResult.positions[0] as {
        status: string;
        reason: string;
      };
      expect(posResult.status).toBe("skipped");
      expect(posResult.reason).toMatch(/warmContractId failed/);
    });

    it("does NOT warm when contractId is non-numeric (already a dated symbol)", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const topstepMock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(topstepMock);

      const tvAccount = makeAccount({
        id: 3001,
        name: "TV-Demo",
        practice: true,
        broker: "tradovate",
      });
      const tvPos = makePosition({ accountId: 3001, contractId: "MNQM26" });
      const tvBroker = makeBrokerMock({
        accounts: [tvAccount],
        positions: [tvPos],
      });
      const tvClient = wireTradovateClient(tvBroker);

      const req = makeRequest({ token: "tok" });
      await POST(req);

      expect(tvClient.warmContractId).not.toHaveBeenCalled();
      expect(tvBroker.placeOrder).toHaveBeenCalledOnce();
    });
  });

  // ── Resting-order sweep ──────────────────────────────────────────────────────

  describe("resting-order sweep after close", () => {
    it("fetches open orders with forceFresh and cancels working orders after positions close", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const restingStop = makeOrder({
        id: 70001,
        accountId: 2001,
        status: 1, // working
      });
      const filledOrder = makeOrder({
        id: 70002,
        accountId: 2001,
        status: 2, // filled — should NOT be cancelled
      });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
        openOrders: [restingStop, filledOrder],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mock.searchOpenOrders).toHaveBeenCalledWith(2001, { forceFresh: true });
      expect(mock.cancelOrder).toHaveBeenCalledOnce();
      expect(mock.cancelOrder).toHaveBeenCalledWith(70001, 2001);

      const body = await res.json();
      const accountResult = body.results.find(
        (r: { accountId: number }) => r.accountId === 2001,
      );
      expect(accountResult.cancelledOrders).toHaveLength(1);
      expect(accountResult.cancelledOrders[0]).toMatchObject({
        orderId: 70001,
        status: "ok",
      });
    });

    // A Pending leg (shared 5 — Topstep's wire Pending since A89, Tradovate's
    // PendingNew/PendingReplace/…) still rests on the book; left behind, it
    // can go working on a now-flat account and open an unprotected position.
    it("cancels Pending orders too, and leaves Cancelled and Rejected ones", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
        openOrders: [
          makeOrder({ id: 71001, accountId: 2001, status: 1 }), // working
          makeOrder({ id: 71005, accountId: 2001, status: 5 }), // pending
          makeOrder({ id: 71003, accountId: 2001, status: 3 }), // cancelled
          makeOrder({ id: 71004, accountId: 2001, status: 4 }), // rejected
        ],
      });
      wireTopstepClient(mock);

      const res = await POST(makeRequest({ token: "tok" }));
      expect(res.status).toBe(200);

      expect(mock.cancelOrder.mock.calls.map((c) => c[0]).sort()).toEqual([71001, 71005]);
    });

    it("records per-cancel failures and continues; account stays in results", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const restingA = makeOrder({ id: 81, accountId: 2001, status: 1 });
      const restingB = makeOrder({ id: 82, accountId: 2001, status: 1 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
        openOrders: [restingA, restingB],
        cancelOrderImpl: async (orderId) => {
          if (orderId === 81) throw new Error("already cancelled");
        },
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      const accountResult = body.results.find(
        (r: { accountId: number }) => r.accountId === 2001,
      );
      // Position close succeeded; cancel failure flips account status to error
      expect(accountResult.status).toBe("error");
      expect(accountResult.cancelledOrders).toHaveLength(2);
      const failed = accountResult.cancelledOrders.find(
        (c: { orderId: number }) => c.orderId === 81,
      );
      const ok = accountResult.cancelledOrders.find(
        (c: { orderId: number }) => c.orderId === 82,
      );
      expect(failed.status).toBe("error");
      expect(failed.reason).toContain("already cancelled");
      expect(ok.status).toBe("ok");
    });

    it("records searchOpenOrders failure without aborting the account result", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
        searchOpenOrdersImpl: async () => { throw new Error("gateway 500"); },
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      const accountResult = body.results.find(
        (r: { accountId: number }) => r.accountId === 2001,
      );
      // Position closed OK but sweep failed → account flips to error
      expect(accountResult.status).toBe("error");
      expect(accountResult.cancelledOrders).toHaveLength(1);
      expect(accountResult.cancelledOrders[0].reason).toContain("searchOpenOrders failed");
    });
  });

  // ── Partial failure ──────────────────────────────────────────────────────────

  describe("partial position close failure", () => {
    it("fires all position closes even when one fails; failures captured in results", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos1 = makePosition({ id: 1, contractId: "CON.F.US.MNQ.M26", type: 1 });
      const pos2 = makePosition({ id: 2, contractId: "CON.F.US.MES.M26", type: 1 });

      let callCount = 0;
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos1, pos2],
        placeOrderImpl: async (order) => {
          callCount++;
          if (order.contractId === "CON.F.US.MES.M26") {
            throw new Error("market closed");
          }
          return { orderId: 9001 };
        },
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200); // partial failure is still HTTP 200

      expect(callCount).toBe(2); // both were attempted

      const body = await res.json();
      const accountResult = body.results.find(
        (r: { accountId: number }) => r.accountId === 2001,
      );
      expect(accountResult.status).toBe("error");

      const posResults = accountResult.positions as Array<{
        contractId: string;
        status: string;
        reason?: string;
      }>;
      const ok = posResults.find((p) => p.contractId === "CON.F.US.MNQ.M26");
      const err = posResults.find((p) => p.contractId === "CON.F.US.MES.M26");
      expect(ok?.status).toBe("ok");
      expect(err?.status).toBe("error");
      expect(err?.reason).toContain("market closed");
    });

    it("ok is false when any result has status error", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
        placeOrderImpl: async () => { throw new Error("rejected"); },
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  // ── Multi-broker fan-out ─────────────────────────────────────────────────────

  describe("multi-broker fan-out", () => {
    it("includes Tradovate accounts alongside Topstep accounts when client is configured", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);

      const topstepAccount = makeAccount({
        id: 1001,
        name: "PRAC-1001",
        practice: true,
        broker: "topstep",
      });
      const tradovateAccount = makeAccount({
        id: 3001,
        name: "TV-Demo",
        practice: true,
        broker: "tradovate",
      });

      const topstepPos = makePosition({ id: 10, accountId: 1001 });
      // Non-numeric contractId so the warm path is skipped.
      const tradovatePos = makePosition({
        id: 20,
        accountId: 3001,
        contractId: "MNQM26",
      });

      const topstepMock = makeBrokerMock({
        accounts: [topstepAccount],
        positions: [topstepPos],
      });
      wireTopstepClient(topstepMock);

      const tradovateMock = makeBrokerMock({
        accounts: [tradovateAccount],
        positions: [tradovatePos],
      });
      wireTradovateClient(tradovateMock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.attempted).toBe(2);
      expect(topstepMock.placeOrder).toHaveBeenCalledOnce();
      expect(tradovateMock.placeOrder).toHaveBeenCalledOnce();
    });

    it("proceeds with Topstep-only results when Tradovate is not configured (null client)", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);

      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const mock = makeBrokerMock({ accounts: [practiceAccount], positions: [pos] });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.attempted).toBe(1);
      expect(mock.placeOrder).toHaveBeenCalledOnce();
    });

    it("records Tradovate searchAccounts failure in results but still proceeds", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);

      const topstepAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const topstepMock = makeBrokerMock({
        accounts: [topstepAccount],
        positions: [pos],
      });
      wireTopstepClient(topstepMock);

      const tradovateMock = makeBrokerMock({
        accounts: [],
        searchAccountsImpl: async () => { throw new Error("Tradovate auth expired"); },
      });
      wireTradovateClient(tradovateMock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200); // partial coverage beats zero coverage

      const body = await res.json();
      // Topstep position should still fire
      expect(topstepMock.placeOrder).toHaveBeenCalledOnce();
      // The error is recorded in results
      const errResult = body.results.find(
        (r: { broker: string; status: string }) =>
          r.broker === "tradovate" && r.status === "error",
      );
      expect(errResult).toBeDefined();
      expect(errResult.reason).toContain("Tradovate auth expired");
    });
  });

  // ── Topstep searchAccounts failure (soft) ────────────────────────────────────

  describe("Topstep searchAccounts failure (soft)", () => {
    it("returns HTTP 200 with ok:false and records error in results when Topstep searchAccounts throws", async () => {
      const failingMock = makeBrokerMock({
        searchAccountsImpl: async () => { throw new Error("gateway timeout"); },
      });
      wireTopstepClient(failingMock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(false);
      const errResult = body.results.find(
        (r: { broker: string; status: string }) =>
          r.broker === "topstep" && r.status === "error",
      );
      expect(errResult).toBeDefined();
      expect(errResult.reason).toMatch(/gateway timeout/);
    });

    it("Tradovate still fires when Topstep searchAccounts fails", async () => {
      // Topstep broker rejects searchAccounts
      const failingTopstep = makeBrokerMock({
        searchAccountsImpl: async () => { throw new Error("topstep down"); },
      });
      wireTopstepClient(failingTopstep);

      // Tradovate broker is healthy and has one practice account with a position
      const tvAccount = makeAccount({
        id: 3001,
        name: "TV-Demo",
        practice: true,
        broker: "tradovate",
      });
      const tvPos = makePosition({ accountId: 3001, contractId: "MNQM26" });
      const tvBroker = makeBrokerMock({
        accounts: [tvAccount],
        positions: [tvPos],
      });
      wireTradovateClient(tvBroker);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.ok).toBe(false); // Topstep error still flips ok
      expect(tvBroker.placeOrder).toHaveBeenCalledOnce();
    });
  });

  // ── Concurrency guard ────────────────────────────────────────────────────────

  describe("concurrency guard", () => {
    it("rejects a second concurrent POST with 409", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });

      // Block the first call until we release it so the second sees inflight.
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
        searchAccountsImpl: async () => {
          await firstGate;
          return [practiceAccount];
        },
      });
      wireTopstepClient(mock);

      const first = POST(makeRequest({ token: "tok" }));
      // Yield so the first call enters the inflight section.
      await Promise.resolve();

      const secondRes = await POST(makeRequest({ token: "tok" }));
      expect(secondRes.status).toBe(409);
      const secondBody = await secondRes.json();
      expect(secondBody.error).toMatch(/in flight/);

      releaseFirst();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    });

    it("clears inflight after the first call resolves so a follow-up POST proceeds", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const mock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(mock);

      const res1 = await POST(makeRequest({ token: "tok" }));
      expect(res1.status).toBe(200);

      // A follow-up call must not see a stale inflight guard.
      const res2 = await POST(makeRequest({ token: "tok" }));
      expect(res2.status).toBe(200);
    });
  });

  // ── Response shape ───────────────────────────────────────────────────────────

  describe("response shape", () => {
    it("always returns ok, env, isProd, attempted, and results fields", async () => {
      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      const body = await res.json();

      expect(typeof body.ok).toBe("boolean");
      expect(body.env === "prod" || body.env === "staging").toBe(true);
      expect(typeof body.isProd).toBe("boolean");
      expect(typeof body.attempted).toBe("number");
      expect(Array.isArray(body.results)).toBe(true);
    });

    it("attempted counts only accounts that had open positions, not skipped or error accounts", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(true);

      // live account: has a position and fires
      const liveAccount = makeAccount({ id: 1001, practice: false, broker: "topstep" });
      // practice account: skipped in prod
      const practiceAccount = makeAccount({ id: 2001, practice: true, broker: "topstep" });
      const pos = makePosition({ accountId: 1001 });

      const mock = makeBrokerMock({
        accounts: [liveAccount, practiceAccount],
        positions: [pos],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      const body = await res.json();
      expect(body.attempted).toBe(1);
    });

    it("ok is true when all position results succeeded", async () => {
      vi.mocked(isProductionEnv).mockReturnValue(false);
      const practiceAccount = makeAccount({ id: 2001, practice: true });
      const pos = makePosition({ accountId: 2001 });
      const mock = makeBrokerMock({
        accounts: [practiceAccount],
        positions: [pos],
      });
      wireTopstepClient(mock);

      const req = makeRequest({ token: "tok" });
      const res = await POST(req);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  // ── setToken is called ────────────────────────────────────────────────────────

  describe("token plumbing", () => {
    it("stamps the TopstepClient with the plugin's JWT, not a request header", async () => {
      const mock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(mock);
      vi.mocked(topstepBrowserToken).mockResolvedValue("plugin-held-jwt");

      await POST(makeRequest({ token: "my-secret-token" }));

      expect(mock.setToken).toHaveBeenCalledWith("plugin-held-jwt");
    });

    it("leaves Topstep out of the fan-out entirely when it has no JWT", async () => {
      const mock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(mock);
      vi.mocked(topstepBrowserToken).mockResolvedValue(null);

      await POST(makeRequest({ token: "tok" }));

      expect(mock.searchAccounts).not.toHaveBeenCalled();
    });

    it("reports a Topstep auth failure as a soft per-broker error", async () => {
      const mock = makeBrokerMock({ accounts: [], positions: [] });
      wireTopstepClient(mock);
      vi.mocked(topstepBrowserToken).mockRejectedValue(new Error("gateway down"));

      const res = await POST(makeRequest({ token: "tok" }));
      const body = (await res.json()) as {
        ok: boolean;
        results: Array<{ broker: string; status: string; reason?: string }>;
      };

      expect(res.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(
        body.results.some((r) => r.broker === "topstep" && r.reason?.includes("gateway down")),
      ).toBe(true);
    });
  });

  // ── exit-latch observation ───────────────────────────────────────────────────

  describe("in-flight engine exits", () => {
    function wireEngine(exitsByAccount: Record<number, string[]>) {
      vi.mocked(getEngineIfReady).mockReturnValue({
        exitsInFlightForAccount: vi.fn((accountId: number) => exitsByAccount[accountId] ?? []),
      } as unknown as ReturnType<typeof getEngineIfReady>);
    }

    function stagingAccountWithPosition() {
      const account = makeAccount({ id: 2001, practice: true });
      const mock = makeBrokerMock({
        accounts: [account],
        positions: [makePosition({ accountId: 2001 })],
      });
      wireTopstepClient(mock);
      return mock;
    }

    it("still places the market exit when an engine exit is already in flight", async () => {
      const mock = stagingAccountWithPosition();
      wireEngine({ 2001: ["dep-aaaa"] });

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();

      expect(mock.placeOrder).toHaveBeenCalledTimes(1);
      expect(body.results[0].status).toBe("ok");
      expect(body.ok).toBe(true);
    });

    it("reports the in-flight deployment ids on the account result", async () => {
      stagingAccountWithPosition();
      wireEngine({ 2001: ["dep-aaaa", "dep-bbbb"] });

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();

      expect(body.results[0].exitsInFlight).toEqual(["dep-aaaa", "dep-bbbb"]);
    });

    it("omits exitsInFlight entirely when no engine exit is in flight", async () => {
      stagingAccountWithPosition();
      wireEngine({});

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();

      expect(body.results[0]).not.toHaveProperty("exitsInFlight");
      expect(body.results[0]).not.toHaveProperty("exitsInFlightUnknown");
    });

    it("flattens normally when the engine is not running", async () => {
      const mock = stagingAccountWithPosition();
      vi.mocked(getEngineIfReady).mockReturnValue(null);

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();

      expect(mock.placeOrder).toHaveBeenCalledTimes(1);
      expect(body.results[0]).not.toHaveProperty("exitsInFlight");
    });

    // The rule: observe the latch, never defer to it — a read that throws is
    // reported, not a gate.
    it("still places the market exit when the latch read throws, and logs it", async () => {
      const mock = stagingAccountWithPosition();
      vi.mocked(getEngineIfReady).mockReturnValue({
        exitsInFlightForAccount: vi.fn(() => {
          throw new Error("latch read failed");
        }),
      } as unknown as ReturnType<typeof getEngineIfReady>);
      const logged = vi.spyOn(log, "event").mockImplementation(() => {});

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();
      const calls = [...logged.mock.calls];
      logged.mockRestore();
      vi.mocked(getEngineIfReady).mockReturnValue(null);

      expect(mock.placeOrder).toHaveBeenCalledTimes(1);
      expect(body.results[0].status).toBe("ok");
      expect(body.results[0]).not.toHaveProperty("exitsInFlight");
      // The absent list must not read as "none in flight".
      expect(body.results[0].exitsInFlightUnknown).toBe(true);
      expect(calls).toContainEqual([
        "flatten_all_exits_in_flight",
        "flatten-all",
        "account=2001 exit latch unreadable (latch read failed) — flattening anyway",
        { accountId: 2001 },
      ]);
    });

    // In a `web` process the latch read crosses to the engine process. No
    // answer from it is that read throwing, and the panic button, which goes
    // to the brokers itself, must not answer the engine's 503 for it.
    it("still places the market exit when the engine process gives no answer to the latch read", async () => {
      const mock = stagingAccountWithPosition();
      vi.mocked(getEngineIfReady).mockReturnValue({
        exitsInFlightForAccount: vi.fn(() => {
          throw new EngineUnreachableError("exitsInFlightForAccount", "timed out after 10000 ms");
        }),
      } as unknown as ReturnType<typeof getEngineIfReady>);

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();
      vi.mocked(getEngineIfReady).mockReturnValue(null);

      expect(res.status).toBe(200);
      expect(mock.placeOrder).toHaveBeenCalledTimes(1);
      expect(body.results[0].status).toBe("ok");
      expect(body.results[0].exitsInFlightUnknown).toBe(true);
    });

    // A121: the positions were read before `flattenAccount` rejected, so the
    // body names them instead of writing `positions: []`, which the button
    // reads as an account never reached. With the latch read caught, the only
    // throw left before the first submit is the in-flight log line itself.
    function rejectedAccount() {
      const account = makeAccount({ id: 2001, practice: true });
      const mock = makeBrokerMock({
        accounts: [account],
        positions: [
          makePosition({ id: 1, accountId: 2001, contractId: "CON.F.US.MNQ.Z26", size: 2 }),
          makePosition({ id: 2, accountId: 2001, contractId: "CON.F.US.MES.Z26", size: 1 }),
        ],
      });
      wireTopstepClient(mock);
      wireEngine({ 2001: ["dep-aaaa"] });
      const logged = vi.spyOn(log, "event").mockImplementation((event) => {
        if (event === "flatten_all_exits_in_flight") throw new Error("log sink down");
      });
      return { account, mock, logged };
    }

    it("a throwing in-flight log line rejects the account before any submit: its read positions are error rows, no sweep ran, and the complete line counts them failed", async () => {
      const { account, mock, logged } = rejectedAccount();

      const res = await POST(makeRequest({ token: "tok" }));
      const body = await res.json();
      const events = logged.mock.calls.map(([event, , message]) => ({ event, message }));
      logged.mockRestore();
      vi.mocked(getEngineIfReady).mockReturnValue(null);

      expect(mock.placeOrder).not.toHaveBeenCalled();
      expect(body.results).toEqual([
        {
          accountId: 2001,
          accountName: account.name,
          broker: "topstep",
          status: "error",
          reason: "log sink down",
          positions: [
            { contractId: "CON.F.US.MNQ.Z26", size: 2, status: "error", reason: "log sink down" },
            { contractId: "CON.F.US.MES.Z26", size: 1, status: "error", reason: "log sink down" },
          ],
          cancelledOrders: [{ orderId: -1, status: "error", reason: "sweep not run: log sink down" }],
        },
      ]);
      const complete = events.find((e) => e.event === "flatten_all_complete");
      expect(complete?.message).toContain("closed=0 failed=2 total=2");
    });

    it("the button reads a rejected account's body as may still be open with orders that may remain", async () => {
      const { logged } = rejectedAccount();

      const body = await (await POST(makeRequest({ token: "tok" }))).json();
      logged.mockRestore();
      vi.mocked(getEngineIfReady).mockReturnValue(null);

      const summary = toFlattenAllSummary(body);
      expect(summary).not.toBeNull();
      expect(flattenAllResultLabel(summary!)).toBe("0 closed · 2 may still be open · orders may remain");
    });
  });
});
