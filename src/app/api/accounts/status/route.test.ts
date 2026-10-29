/**
 * `POST /api/accounts/status` — the Settings page's open-time check. It owns
 * no logic of its own beyond the session gate and the error shape; what a
 * check writes is `engine-account-status.test.ts`'s.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// Stub the store seam only, so `requireSession` itself — header name and 401
// shape — still runs for real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const engine = vi.hoisted(() => ({ checkAccountStatuses: vi.fn() }));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngine: vi.fn(async () => engine),
}));

const stored = vi.hoisted(() => ({ balances: vi.fn(), gates: vi.fn() }));

vi.mock("@/lib/db/account-brokers", () => ({ listAccountBalances: stored.balances }));
vi.mock("@/lib/trading/books/account-gates", () => ({ readAccountGates: stored.gates }));

import { GET, POST } from "./route";
import { ACCOUNT_DEAD_REFUSAL } from "@/lib/trading/broker-access/account-state-gate";

function request(token: string | null, method = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/accounts/status", {
    method,
    headers: token ? { "x-session-token": token } : {},
  });
}

beforeEach(() => {
  engine.checkAccountStatuses.mockReset();
  stored.balances.mockReset();
  stored.gates.mockReset();
});

describe("GET /api/accounts/status", () => {
  it("refuses a request with no session, and reads nothing", () => {
    const res = GET(request(null, "GET"));
    expect(res.status).toBe(401);
    expect(stored.balances).not.toHaveBeenCalled();
  });

  it("answers each account's stored balance beside readAccountGates' refusal, verbatim", async () => {
    const refusal = { kind: "dead", stamp: "dead", reason: ACCOUNT_DEAD_REFUSAL };
    stored.balances.mockReturnValue([
      { accountId: 1, broker: "topstep", balanceUsd: 48_722.9, balanceAt: "2026-10-21T21:55:01.000Z", checkedAt: "2026-10-21T21:55:03.000Z" },
      { accountId: 2, broker: "topstep", balanceUsd: null, balanceAt: null, checkedAt: null },
    ]);
    stored.gates.mockReturnValue([
      { accountId: 1, name: "A", refusal, warning: null, replacements: [] },
      { accountId: 2, name: "B", refusal: null, warning: null, replacements: [] },
    ]);
    const res = GET(request("t", "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ refusal: unknown }> };
    expect(body.accounts).toEqual([
      {
        accountId: 1,
        broker: "topstep",
        balanceUsd: 48_722.9,
        balanceAt: "2026-10-21T21:55:01.000Z",
        checkedAt: "2026-10-21T21:55:03.000Z",
        refusal,
      },
      { accountId: 2, broker: "topstep", balanceUsd: null, balanceAt: null, checkedAt: null, refusal: null },
    ]);
    expect(engine.checkAccountStatuses).not.toHaveBeenCalled();
  });
});

describe("POST /api/accounts/status", () => {
  it("refuses a request with no session, and checks nothing", async () => {
    const res = await POST(request(null));
    expect(res.status).toBe(401);
    expect(engine.checkAccountStatuses).not.toHaveBeenCalled();
  });

  it("answers the engine's check, including a broker that did not answer, with a 200", async () => {
    const result = {
      checkedAt: "2026-10-14T21:00:00.000Z",
      answered: ["tradovate"],
      failed: ["topstep"],
      newlyDead: [],
    };
    engine.checkAccountStatuses.mockResolvedValue(result);
    const res = await POST(request("t"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(engine.checkAccountStatuses).toHaveBeenCalledTimes(1);
  });

  it("answers 502 with the reason when the check throws", async () => {
    engine.checkAccountStatuses.mockRejectedValue(new Error("registry down"));
    const res = await POST(request("t"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "registry down" });
  });
});
