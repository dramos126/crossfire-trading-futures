import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Module-level mocks ───────────────────────────────────────────────────────

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

vi.mock("@/lib/brokers/tradovate/penalty", () => ({
  PenaltyResponseHandler: vi.fn().mockImplementation(function (this: { assertCircuitClosed: ReturnType<typeof vi.fn>; handle: ReturnType<typeof vi.fn> }) {
    this.assertCircuitClosed = vi.fn();
    this.handle = vi.fn().mockResolvedValue({ kind: "ok" });
  }),
}));

vi.mock("@/lib/env", () => ({
  isProductionEnv: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn().mockReturnValue(null),
  getTradovateClientIfConfigured: vi.fn().mockResolvedValue(null),
  tradovateAuthError: vi.fn().mockReturnValue(null),
}));

const mockTopstepGetContractById = vi.fn();
const mockTradovateGetContractSpec = vi.fn();
/** Fires from the TradovateClient constructor. The route must never trip it —
 *  a fresh per-request client re-auths on every 2.5s contract-meta poll. */
const mockTradovateConstructed = vi.fn();

vi.mock("@/lib/brokers/topstep/client", () => ({
  TopstepClient: vi.fn().mockImplementation(function (this: { setToken: ReturnType<typeof vi.fn>; getContractById: ReturnType<typeof vi.fn> }) {
    this.setToken = vi.fn();
    this.getContractById = mockTopstepGetContractById;
  }),
}));

vi.mock("@/lib/brokers/topstep/browser-token", () => ({
  topstepBrowserToken: vi.fn().mockResolvedValue("topstep-jwt"),
}));

vi.mock("@/lib/brokers/tradovate/client", () => ({
  TradovateClient: vi.fn().mockImplementation(function (this: { authenticate: ReturnType<typeof vi.fn>; getContractSpec: ReturnType<typeof vi.fn> }) {
    mockTradovateConstructed();
    this.authenticate = vi.fn();
    this.getContractSpec = mockTradovateGetContractSpec;
  }),
}));

import { POST } from "./route";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import {
  getEngineIfReady,
  getTradovateClientIfConfigured,
  tradovateAuthError,
} from "@/lib/trading/engine/engine-singleton";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(opts: {
  token?: string;
  body?: unknown;
}): NextRequest {
  const url = "http://localhost/api/contracts/by-id";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["x-session-token"] = opts.token;
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/contracts/by-id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEngineIfReady).mockReturnValue(null);
    vi.mocked(tradovateAuthError).mockReturnValue(null);
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue({
      getContractSpec: mockTradovateGetContractSpec,
    } as unknown as TradovateClient);
  });

  describe("guard clauses", () => {
    it("returns 401 when x-session-token header is missing", async () => {
      const req = makeRequest({ body: { contractId: "12345" } });
      const res = await POST(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ error: expect.stringContaining("token") });
    });

    it("returns 400 when contractId is missing from body", async () => {
      const req = makeRequest({ token: "tok-abc", body: {} });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: expect.stringContaining("contractId") });
    });

    it("returns 400 when contractId is a number (not a string)", async () => {
      // The route checks `typeof contractId !== 'string'`.
      const req = makeRequest({ token: "tok-abc", body: { contractId: 12345 } });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("Tradovate path — numeric contractId", () => {
    it("routes numeric contractId to TradovateClient.getContractSpec", async () => {
      mockTradovateGetContractSpec.mockResolvedValue({ tickSize: 0.25, tickValue: 1.25 });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(getTradovateClientIfConfigured).toHaveBeenCalledOnce();
      expect(mockTradovateGetContractSpec).toHaveBeenCalledWith(12345);
    });

    it("takes the client from the engine singleton and never constructs its own", async () => {
      // The browser polls this route once per 2.5s tick for every contract
      // missing from the meta cache. A fresh client re-authenticates on each
      // one, which trips the broker-unavailable circuit and auto-pauses
      // deployments — a cosmetic lookup taking the engine down.
      mockTradovateGetContractSpec.mockResolvedValue({ tickSize: 0.25, tickValue: 1.25 });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      await POST(req);

      expect(mockTradovateConstructed).not.toHaveBeenCalled();
    });

    it("returns 503 when Tradovate is not configured", async () => {
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      const res = await POST(req);

      // Not 404 — the contract may well exist; nothing was asked.
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "Tradovate is not configured" });
      expect(mockTradovateGetContractSpec).not.toHaveBeenCalled();
    });

    it("names the auth failure rather than reporting Tradovate unconfigured", async () => {
      // A null client is also "the first auth failed" — and a captcha
      // lockout has an operator recovery (wait it out) that a
      // not-configured message sends them looking for missing credentials.
      vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);
      vi.mocked(tradovateAuthError).mockReturnValue(
        "Tradovate p-captcha lockout on /auth/accesstokenrequest — third-party access disabled for ~1h",
      );

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      const res = await POST(req);

      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain("p-captcha lockout");
    });

    it("returns { contract: { id, name, tickSize, tickValue } } for numeric contractId", async () => {
      mockTradovateGetContractSpec.mockResolvedValue({ tickSize: 0.25, tickValue: 1.25 });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      const res = await POST(req);

      const body = await res.json();
      expect(body).toEqual({
        contract: {
          id: "12345",
          name: "12345",
          tickSize: 0.25,
          tickValue: 1.25,
        },
      });
    });

    it("returns 404 when getContractSpec returns null", async () => {
      mockTradovateGetContractSpec.mockResolvedValue(null);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "99999" } });
      const res = await POST(req);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/99999/);
    });

    it("does not call TopstepClient.getContractById for numeric contractId", async () => {
      mockTradovateGetContractSpec.mockResolvedValue({ tickSize: 0.25, tickValue: 1.25 });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      await POST(req);

      expect(mockTopstepGetContractById).not.toHaveBeenCalled();
    });

    it("numeric contractId with leading zeros is still recognized as numeric", async () => {
      // "007" passes /^\d+$/ and Number.isFinite(7) → Tradovate path.
      mockTradovateGetContractSpec.mockResolvedValue({ tickSize: 0.5, tickValue: 5 });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "007" } });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTradovateGetContractSpec).toHaveBeenCalled();
    });
  });

  describe("Topstep path — dotted contractId", () => {
    it("routes dotted contractId to TopstepClient.getContractById", async () => {
      const fakeContract = { id: "CON.F.US.MNQ.M25", name: "MNQ Jun25", tickSize: 0.25, tickValue: 0.5 };
      mockTopstepGetContractById.mockResolvedValue(fakeContract);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "CON.F.US.MNQ.M25" } });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTopstepGetContractById).toHaveBeenCalledWith("CON.F.US.MNQ.M25");
      expect(getTradovateClientIfConfigured).not.toHaveBeenCalled();
    });

    it("returns the contract from TopstepClient unchanged", async () => {
      const fakeContract = { id: "CON.F.US.ES.M25", name: "ES Jun25", tickSize: 0.25, tickValue: 12.5 };
      mockTopstepGetContractById.mockResolvedValue(fakeContract);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "CON.F.US.ES.M25" } });
      const res = await POST(req);

      const body = await res.json();
      expect(body).toEqual({ contract: fakeContract });
    });

    it("hyphenated contractId (e.g. NQ-2025) routes to Topstep, not Tradovate", async () => {
      // "NQ-2025" is not purely digits and engine returns null → Topstep fallback.
      const fakeContract = { id: "NQ-2025", name: "NQ" };
      mockTopstepGetContractById.mockResolvedValue(fakeContract);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "NQ-2025" } });
      await POST(req);

      expect(mockTopstepGetContractById).toHaveBeenCalledWith("NQ-2025");
      expect(mockTradovateGetContractSpec).not.toHaveBeenCalled();
    });
  });

  describe("Tradovate dated symbol path — engine translation", () => {
    it("translates MNQM6 → the id its market data arrives under, then fetches tick meta from Topstep", async () => {
      const fakeEngine = { marketDataContractId: vi.fn().mockResolvedValue("CON.F.US.MNQ.M26") };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getEngineIfReady).mockReturnValue(fakeEngine as any);
      const fakeContract = { id: "CON.F.US.MNQ.M26", name: "MNQ Jun26", tickSize: 0.25, tickValue: 0.5 };
      mockTopstepGetContractById.mockResolvedValue(fakeContract);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "MNQM6" } });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(fakeEngine.marketDataContractId).toHaveBeenCalledWith("MNQM6");
      expect(mockTopstepGetContractById).toHaveBeenCalledWith("CON.F.US.MNQ.M26");
      expect(getTradovateClientIfConfigured).not.toHaveBeenCalled();
    });

    it("returns meta keyed under the original Tradovate symbol (MNQM6, not the Topstep id)", async () => {
      const fakeEngine = { marketDataContractId: vi.fn().mockResolvedValue("CON.F.US.MNQ.M26") };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getEngineIfReady).mockReturnValue(fakeEngine as any);
      mockTopstepGetContractById.mockResolvedValue({
        id: "CON.F.US.MNQ.M26", name: "MNQ Jun26", tickSize: 0.25, tickValue: 0.5,
      });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "MNQM6" } });
      const res = await POST(req);

      const body = await res.json();
      expect(body).toEqual({
        contract: { id: "MNQM6", name: "MNQM6", tickSize: 0.25, tickValue: 0.5 },
      });
    });

    it("falls through to Topstep getContractById when engine returns null for non-dotted id", async () => {
      // Engine not up → getEngineIfReady returns null → topstepId is null → Topstep fallback.
      vi.mocked(getEngineIfReady).mockReturnValue(null);
      const fakeContract = { id: "MNQM6", name: "MNQM6", tickSize: 0.25, tickValue: 0.5 };
      mockTopstepGetContractById.mockResolvedValue(fakeContract);

      const req = makeRequest({ token: "tok-abc", body: { contractId: "MNQM6" } });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTopstepGetContractById).toHaveBeenCalledWith("MNQM6");
    });

    it("falls through when the engine is up but cannot tell which contract this is", async () => {
      const fakeEngine = { marketDataContractId: vi.fn().mockResolvedValue(null) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getEngineIfReady).mockReturnValue(fakeEngine as any);
      mockTopstepGetContractById.mockResolvedValue({
        id: "MNQM6", name: "MNQM6", tickSize: 0.25, tickValue: 0.5,
      });

      const req = makeRequest({ token: "tok-abc", body: { contractId: "MNQM6" } });
      const res = await POST(req);

      expect(res.status).toBe(200);
      expect(mockTopstepGetContractById).toHaveBeenCalledWith("MNQM6");
    });
  });

  describe("error handling", () => {
    it("returns 500 when getTradovateClientIfConfigured throws", async () => {
      vi.mocked(getTradovateClientIfConfigured).mockRejectedValue(new Error("Credentials not configured"));

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("Credentials not configured");
    });

    it("returns 500 when TradovateClient.getContractSpec throws", async () => {
      mockTradovateGetContractSpec.mockRejectedValue(new Error("Network error"));

      const req = makeRequest({ token: "tok-abc", body: { contractId: "12345" } });
      const res = await POST(req);

      expect(res.status).toBe(500);
    });

    it("returns 500 when TopstepClient.getContractById throws", async () => {
      mockTopstepGetContractById.mockRejectedValue(new Error("Failed to fetch contract"));

      const req = makeRequest({ token: "tok-abc", body: { contractId: "CON.F.US.MNQ.M25" } });
      const res = await POST(req);

      expect(res.status).toBe(500);
    });

    it("returns generic error message when thrown error is not an Error instance", async () => {
      mockTopstepGetContractById.mockRejectedValue("plain string");

      const req = makeRequest({ token: "tok-abc", body: { contractId: "CON.F.US.MNQ.M25" } });
      const res = await POST(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
    });
  });
});
