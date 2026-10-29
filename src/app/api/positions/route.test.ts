import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { BrokerKind } from "@/lib/db/account-brokers";

// ── Module-level mocks ────────────────────────────────────────────────────────
// All vi.mock() calls are hoisted to top of file by vitest. Variables declared
// with const/let below them are NOT yet initialized at hoist time, so vi.mock
// factories must be self-contained — no module-scope variable references.

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

vi.mock("@/lib/brokers/topstep/client", () => ({
  TopstepClient: vi.fn().mockImplementation(function (this: { setToken: ReturnType<typeof vi.fn>; searchOpenPositions: ReturnType<typeof vi.fn> }) {
    this.setToken = vi.fn();
    this.searchOpenPositions = vi.fn().mockResolvedValue([]);
  }),
}));

vi.mock("@/lib/brokers/topstep/browser-token", () => ({
  topstepBrowserToken: vi.fn().mockResolvedValue("topstep-jwt"),
}));

vi.mock("@/lib/db/account-brokers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/account-brokers")>();
  return {
    ...actual,
    getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  };
});

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getTradovateClientIfConfigured: vi.fn().mockResolvedValue(null),
  getTradovateRealtimeAdapter: vi.fn().mockReturnValue(null),
}));

// ── Import modules after mocks are declared ───────────────────────────────────

import { GET } from "./route";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import type { Position } from "@/lib/brokers/types";
import {
  ACCOUNT_VIEW_MAX_AGE_MS,
  freshPositions,
  recordPositions,
  resetAccountViewForTests,
} from "@/lib/trading/engine/realtime/account-view";
import { getAccountBrokerOrTopstep } from "@/lib/db/account-brokers";
import {
  getTradovateClientIfConfigured,
  getTradovateRealtimeAdapter,
} from "@/lib/trading/engine/engine-singleton";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(opts: {
  accountId?: string;
  token?: string;
}): NextRequest {
  const url = new URL("http://localhost/api/positions");
  if (opts.accountId !== undefined) url.searchParams.set("accountId", opts.accountId);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["x-session-token"] = opts.token;
  return new NextRequest(url.toString(), { headers });
}

/** Get the mock instance created by the most recent `new TopstepClient()`. */
function lastTopstepInstance() {
  const instances = vi.mocked(TopstepClient).mock.instances;
  return instances[instances.length - 1] as unknown as {
    setToken: ReturnType<typeof vi.fn>;
    searchOpenPositions: ReturnType<typeof vi.fn>;
  };
}

/** Build a fake Tradovate client returned by the singleton mock. */
function makeFakeTradovateClient(positions: unknown[] = []) {
  return {
    searchOpenPositions: vi.fn().mockResolvedValue(positions),
  };
}

// Only `Date` is faked: the view's 60 s rule reads `Date.now()`, and the
// request plumbing keeps its real timers. No calendar is read.
const NOW = new Date("2026-10-23T14:30:00.000Z").getTime();
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function viewPosition(over: Partial<Position> = {}): Position {
  return {
    id: 5,
    accountId: 1001,
    contractId: "CON.F.US.MNQ.Z26",
    creationTimestamp: "2026-10-23T14:00:00.000Z",
    type: 1,
    size: 1,
    averagePrice: 21000,
    ...over,
  };
}

/** Every `searchOpenPositions` any Topstep client built by the route was asked. */
function topstepSearchCalls(): number {
  return vi.mocked(TopstepClient).mock.instances.reduce(
    (n, inst) => n + (inst as unknown as { searchOpenPositions: ReturnType<typeof vi.fn> }).searchOpenPositions.mock.calls.length,
    0,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/positions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetAccountViewForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.mocked(topstepBrowserToken).mockResolvedValue("topstep-jwt");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(TopstepClient).mockImplementation(function (this: any) {
      this.setToken = vi.fn();
      this.searchOpenPositions = vi.fn().mockResolvedValue([]);
    });
    vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Topstep);
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);
    vi.mocked(getTradovateRealtimeAdapter).mockReturnValue(null);
  });

  describe("guard clauses", () => {
    it("returns 401 when x-session-token header is missing", async () => {
      const req = makeRequest({ accountId: "1001" });
      const res = await GET(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ error: expect.stringContaining("token") });
    });

    it("returns 400 when accountId query param is missing", async () => {
      const req = makeRequest({ token: "tok-abc" });
      const res = await GET(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: expect.stringContaining("accountId") });
    });

    // A non-numeric param used to survive as NaN: routed as an untagged
    // account, defaulted to Topstep, and sent upstream as
    // `{ accountId: null }`. Reject it here instead of spending a broker
    // round-trip on a malformed question.
    it.each(["abc", "1.5", "NaN", "1e999"])(
      "returns 400 for a non-integer accountId (%j) without asking a broker",
      async (accountId) => {
        const searchOpenPositions = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vi.mocked(TopstepClient).mockImplementation(function (this: any) {
          this.setToken = vi.fn();
          this.searchOpenPositions = searchOpenPositions;
        });

        const res = await GET(makeRequest({ token: "tok-abc", accountId }));
        expect(res.status).toBe(400);
        expect(searchOpenPositions).not.toHaveBeenCalled();
      },
    );
  });

  describe("Topstep path (default broker)", () => {
    it("calls TopstepClient.searchOpenPositions and returns positions", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Topstep);
      const fakePositions = [{ id: 1, contractId: "CON.F.US.MNQ.M25", netPos: 1 }];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(TopstepClient).mockImplementation(function (this: any) {
        this.setToken = vi.fn();
        this.searchOpenPositions = vi.fn().mockResolvedValue(fakePositions);
      });

      const req = makeRequest({ accountId: "1001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        positions: fakePositions,
        asOf: new Date(NOW).toISOString(),
        source: "route",
      });
      const inst = lastTopstepInstance();
      expect(inst.searchOpenPositions).toHaveBeenCalledWith(1001);
    });

    it("answers from a fresh account view with no broker call", async () => {
      recordPositions(1001, [viewPosition()], "sweep");
      advance(ACCOUNT_VIEW_MAX_AGE_MS - 1);

      const res = await GET(makeRequest({ accountId: "1001", token: "tok-abc" }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        positions: [viewPosition()],
        asOf: new Date(NOW).toISOString(),
        source: "sweep",
      });
      expect(TopstepClient).not.toHaveBeenCalled();
    });

    it("makes one broker call for N concurrent requests on a missing view, and stores it", async () => {
      const fresh = [viewPosition({ size: 2 })];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(TopstepClient).mockImplementation(function (this: any) {
        this.setToken = vi.fn();
        this.searchOpenPositions = vi.fn().mockResolvedValue(fresh);
      });

      const responses = await Promise.all(
        Array.from({ length: 3 }, () => GET(makeRequest({ accountId: "1001", token: "tok-abc" }))),
      );

      expect(topstepSearchCalls()).toBe(1);
      for (const res of responses) expect((await res.json()).positions).toEqual(fresh);
      expect(freshPositions(1001)?.items).toEqual(fresh);
      expect(freshPositions(1001)?.source).toBe("route");
    });

    it("re-reads a view at 60 s", async () => {
      recordPositions(1001, [viewPosition()], "sweep");
      advance(ACCOUNT_VIEW_MAX_AGE_MS);

      const res = await GET(makeRequest({ accountId: "1001", token: "tok-abc" }));

      expect(topstepSearchCalls()).toBe(1);
      expect((await res.json()).source).toBe("route");
    });

    it("answers 503 when Topstep is not configured and the view cannot answer", async () => {
      vi.mocked(topstepBrowserToken).mockResolvedValue(null);

      const res = await GET(makeRequest({ accountId: "1001", token: "tok-abc" }));

      expect(res.status).toBe(503);
    });

    it("does not call getTradovateClientIfConfigured when broker is topstep", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Topstep);

      const req = makeRequest({ accountId: "1001", token: "tok-abc" });
      await GET(req);

      expect(getTradovateClientIfConfigured).not.toHaveBeenCalled();
    });
  });

  describe("Tradovate path", () => {
    it("uses singleton client and returns positions", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      const fakePositions = [{ id: 2, contractId: "12345", netPos: -1 }];
      const fakeClient = makeFakeTradovateClient(fakePositions);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(fakeClient as any);

      const req = makeRequest({ accountId: "2001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ positions: fakePositions });
      expect(fakeClient.searchOpenPositions).toHaveBeenCalledWith(2001);
    });

    it("returns empty positions when singleton returns null (creds not configured)", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);

      const req = makeRequest({ accountId: "2001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ positions: [] });
    });

    it("does not call TopstepClient when broker is tradovate", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(makeFakeTradovateClient() as any);

      const req = makeRequest({ accountId: "2001", token: "tok-abc" });
      await GET(req);

      expect(TopstepClient).not.toHaveBeenCalled();
    });

    it("passes numeric accountId to searchOpenPositions", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      const fakeClient = makeFakeTradovateClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(fakeClient as any);

      const req = makeRequest({ accountId: "9876", token: "tok-abc" });
      await GET(req);

      expect(fakeClient.searchOpenPositions).toHaveBeenCalledWith(9876);
      expect(typeof (fakeClient.searchOpenPositions.mock.calls[0] as unknown[])[0]).toBe("number");
    });
  });

  describe("error handling", () => {
    it("returns 500 when getTradovateClientIfConfigured throws", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      vi.mocked(getTradovateClientIfConfigured).mockRejectedValue(new Error("Auth timeout"));

      const req = makeRequest({ accountId: "2001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Auth timeout");
    });

    it("returns 500 when Tradovate searchOpenPositions throws", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      const fakeClient = { searchOpenPositions: vi.fn().mockRejectedValue(new Error("Network timeout")) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(fakeClient as any);

      const req = makeRequest({ accountId: "2001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Network timeout");
    });

    it("returns 500 when TopstepClient.searchOpenPositions throws", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Topstep);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(TopstepClient).mockImplementation(function (this: any) {
        this.setToken = vi.fn();
        this.searchOpenPositions = vi.fn().mockRejectedValue(new Error("Failed to fetch positions"));
      });

      const req = makeRequest({ accountId: "1001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(500);
    });

    it("returns generic error string when thrown value is not an Error", async () => {
      vi.mocked(getAccountBrokerOrTopstep).mockReturnValue(BrokerKind.Tradovate);
      const fakeClient = { searchOpenPositions: vi.fn().mockRejectedValue("plain string rejection") };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(fakeClient as any);

      const req = makeRequest({ accountId: "2001", token: "tok-abc" });
      const res = await GET(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
    });
  });
});
