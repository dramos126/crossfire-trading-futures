/**
 * `POST /api/internal/engine/<method>`: served by the engine role alone,
 * behind the shared secret, dispatching a listed handle method by name to
 * this process's local handle and answering its result or its error as data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  handle: {
    forceFlatDeployment: vi.fn(),
    nudgeClosingGuard: vi.fn(),
    getLogsByLevel: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sync: vi.fn(),
    engineSessionId: vi.fn(),
    getStagingAllowlist: vi.fn(async (): Promise<number[] | null> => null),
    // What `/api/engine` also reaches, for the same-body comparison.
    getBootAssertionState: vi.fn(async () => "passed"),
    isRunning: vi.fn(async () => true),
    ensureEngine: vi.fn(),
    listTopstepAccounts: vi.fn(async () => []),
  } as Record<string, ReturnType<typeof vi.fn>>,
  // The catalog the one predicate reads: an id absent here is unclassifiable.
  identities: new Map<number, { name: string; broker: "topstep" | "tradovate"; practice: boolean }>(),
  closing: [] as Array<{ id: string; status: string }>,
  leaseHeld: true,
}));

vi.mock("@/lib/db/lease", () => ({ holdsLease: () => h.leaseHeld }));

vi.mock("@/lib/trading/engine/handle/local", () => ({ localEngineHandle: () => h.handle }));
vi.mock("@/lib/db/connection", () => ({
  getDb: () => {
    throw new Error("no database in a route test");
  },
}));
vi.mock("@/lib/db/account-brokers", async () => {
  const { autoTradeVerdict } = await vi.importActual<
    typeof import("@/lib/trading/broker-access/account-trading-policy")
  >("@/lib/trading/broker-access/account-trading-policy");
  return {
    BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
    autoTradeVerdictForAccountId: (id: number) => autoTradeVerdict(h.identities.get(id) ?? null),
    getAccountBrokerOrTopstep: () => "topstep",
  };
});
vi.mock("@/lib/db/deployments", () => ({
  listClosingDeployments: () => h.closing,
  listManagedDeployments: () => [],
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: () => null }));
vi.mock("@/lib/logger", () => ({ log: { event: vi.fn() } }));

import { POST } from "./route";
import { POST as enginePOST } from "@/app/api/engine/route";
import { EngineNotInThisProcessError } from "@/lib/role";
import {
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";

const SECRET = "internal-secret-under-test-32-chars-plus";
const env = { role: process.env.CROSSFIRE_ROLE, secret: process.env.CROSSFIRE_INTERNAL_SECRET };

beforeEach(() => {
  vi.clearAllMocks();
  h.identities.clear();
  h.closing = [];
  h.leaseHeld = true;
  h.handle.getStagingAllowlist.mockResolvedValue(null);
  process.env.CROSSFIRE_ROLE = "engine";
  process.env.CROSSFIRE_INTERNAL_SECRET = SECRET;
});

afterEach(() => {
  for (const [key, value] of [
    ["CROSSFIRE_ROLE", env.role],
    ["CROSSFIRE_INTERNAL_SECRET", env.secret],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function call(method: string, body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  const req = new NextRequest(`http://engine:3000/api/internal/engine/${method}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ method }) });
}

describe("who is served", () => {
  it.each(["all", "web"])("answers 404 in the %s role and calls nothing, secret or not", async (role) => {
    process.env.CROSSFIRE_ROLE = role;
    const res = await call("engineSessionId", { args: [] });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "EngineEndpointNotServed" } });
    expect(h.handle.engineSessionId).not.toHaveBeenCalled();
  });

  it.each([
    ["no authorization header", null],
    ["a wrong secret", "Bearer not-the-secret"],
    ["the secret without the scheme", SECRET],
    ["an empty bearer", "Bearer "],
  ])("answers 401 to %s", async (_label, auth) => {
    const res = await call("engineSessionId", { args: [] }, auth);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "EngineEndpointUnauthorized" } });
    expect(h.handle.engineSessionId).not.toHaveBeenCalled();
  });

  it.each([
    ["no secret", ""],
    ["a whitespace secret", "    "],
    ["a short secret", "s3cret"],
  ])("refuses every request when the engine process has %s set", async (_label, value) => {
    process.env.CROSSFIRE_INTERNAL_SECRET = value;
    const res = await call("engineSessionId", { args: [] }, `Bearer ${value}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "InternalSecretMissing" } });
    expect(h.handle.engineSessionId).not.toHaveBeenCalled();
  });

  it("accepts the trimmed secret when the variable carries whitespace", async () => {
    process.env.CROSSFIRE_INTERNAL_SECRET = `  ${SECRET}\n`;
    const res = await call("engineSessionId", { args: [] });
    expect(res.status).toBe(200);
  });
});

describe("the screens on a caller-supplied deployment list", () => {
  const PRAC = { name: "PRAC-V2-1", broker: "topstep" as const, practice: true };
  const FUNDED = { name: "S1-0001", broker: "topstep" as const, practice: false };
  const practiceRow = { id: "d-prac", accountId: 1, deletedAt: null };
  const liveRow = { id: "d-live", accountId: 2, deletedAt: null };
  const unknownRow = { id: "d-unknown", accountId: 3, deletedAt: null };

  beforeEach(() => {
    h.identities.set(1, PRAC);
    h.identities.set(2, FUNDED);
  });

  it.each(["start", "sync"] as const)(
    "%s withholds a live account's row and an unclassifiable one, and runs the rest",
    async (method) => {
      const res = await call(method, { args: [[practiceRow, liveRow, unknownRow]] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        skippedLiveAccounts: [
          { id: "d-live", accountId: 2, reason: LIVE_ACCOUNT_REFUSAL },
          { id: "d-unknown", accountId: 3, reason: UNVERIFIED_ACCOUNT_REFUSAL },
        ],
        skippedNotAllowed: [],
      });
      expect(h.handle[method]).toHaveBeenCalledWith([practiceRow]);
    },
  );

  it.each([
    ["start", "start"],
    ["sync", "update"],
  ] as const)("%s refuses the same rows with the same entries /api/engine answers %s with", async (method, action) => {
    h.handle.getStagingAllowlist.mockResolvedValue([1]);
    h.identities.set(4, PRAC);
    const notAllowed = { id: "d-other", accountId: 4, deletedAt: null };
    const rows = [practiceRow, liveRow, unknownRow, notAllowed];

    const internal = await (await call(method, { args: [rows] })).json();
    const route = await (
      await enginePOST(
        new NextRequest("http://localhost/api/engine", {
          method: "POST",
          body: JSON.stringify({ action, deployments: rows, practiceOnly: false }),
        }),
      )
    ).json();

    expect(internal.skippedLiveAccounts).toEqual(route.skippedLiveAccounts);
    expect(internal.skippedNotAllowed).toEqual(route.skippedNotAllowed);
    expect(internal.skippedLiveAccounts.map((s: { id: string }) => s.id)).toEqual(["d-live", "d-unknown"]);
    expect(internal.skippedNotAllowed).toEqual([{ id: "d-other", accountId: 4 }]);
    expect(h.handle[method].mock.calls.map((c) => c[0])).toEqual([[practiceRow], [practiceRow]]);
  });

  it.each([
    ["no list", []],
    ["a list of non-rows", [[1, 2]]],
    ["a row with no account id", [[{ id: "d1" }]]],
  ])("answers 400 to start with %s and starts nothing", async (_label, args) => {
    const res = await call("start", { args });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "BadEngineRequest" } });
    expect(h.handle.start).not.toHaveBeenCalled();
  });
});

describe("stop while deployments are closing", () => {
  it("answers 409 with the closing rows, as /api/engine does, and stops nothing", async () => {
    h.closing = [{ id: "d-closing", status: "Pausing" }];
    const res = await call("stop", { args: [] });
    expect(res.status).toBe(409);
    const body = await res.json();
    const route = await enginePOST(
      new NextRequest("http://localhost/api/engine", { method: "POST", body: JSON.stringify({ action: "stop" }) }),
    );
    expect(route.status).toBe(409);
    const routeBody = await route.json();
    expect(body).toEqual({
      ok: false,
      error: { name: "EngineStopWhileClosing", message: routeBody.error },
      closing: routeBody.closing,
    });
    expect(body.closing).toEqual([{ id: "d-closing", status: "Pausing" }]);
    expect(h.handle.stop).not.toHaveBeenCalled();
  });

  it("stops when nothing is closing", async () => {
    const res = await call("stop", { args: [] });
    expect(res.status).toBe(200);
    expect(h.handle.stop).toHaveBeenCalledTimes(1);
  });
});

describe("the body cap", () => {
  it("answers 413 to a body over 64 KiB and calls nothing", async () => {
    const res = await call("getLogsByLevel", { args: ["x".repeat(64 * 1024)] });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "EngineRequestTooLarge" } });
    expect(h.handle.getLogsByLevel).not.toHaveBeenCalled();
  });

  it("accepts a body just under it", async () => {
    const res = await call("getLogsByLevel", { args: ["x".repeat(64 * 1024 - 100)] });
    expect(res.status).toBe(200);
  });
});

describe("dispatch", () => {
  it("runs a listed method with its arguments and answers its result", async () => {
    h.handle.getLogsByLevel.mockResolvedValue({ info: [{ message: "a" }] });
    const res = await call("getLogsByLevel", { args: [25] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { info: [{ message: "a" }] } });
    expect(h.handle.getLogsByLevel).toHaveBeenCalledWith(25);
    expect(h.handle.getLogsByLevel.mock.contexts[0]).toBe(h.handle);
  });

  it("answers a peek's null as null, and a void method with no result", async () => {
    h.handle.forceFlatDeployment.mockResolvedValue(null);
    expect(await (await call("forceFlatDeployment", { args: ["d4"] })).json()).toEqual({ ok: true, result: null });
    h.handle.engineSessionId.mockResolvedValue(undefined);
    expect(await (await call("engineSessionId", { args: [] })).json()).toEqual({ ok: true });
  });

  it.each(["subscribeEvents", "constructor", "__proto__", "toString", "hasOwnProperty", "notAMethod"])(
    "refuses %s, which is off the list, with 404",
    async (method) => {
      const res = await call(method, { args: [] });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: { name: "UnknownEngineMethod" } });
    },
  );

  it.each([
    ["no args array", { args: "x" }],
    ["no body object", [1, 2]],
    ["a body that is not JSON", "{"],
  ])("answers 400 to %s", async (_label, body) => {
    const res = await call("engineSessionId", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: { name: "BadEngineRequest" } });
    expect(h.handle.engineSessionId).not.toHaveBeenCalled();
  });
});

describe("a thrown error", () => {
  it("answers its name and message with 500, as the handle routes answer a throw", async () => {
    const err = new Error("Topstep down");
    err.name = "TopstepUnavailable";
    h.handle.getLogsByLevel.mockRejectedValue(err);
    const res = await call("getLogsByLevel", { args: [1] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: { name: "TopstepUnavailable", message: "Topstep down" } });
  });

  it("answers an engine that is not in this process with 503", async () => {
    h.handle.start.mockRejectedValue(new EngineNotInThisProcessError("getEngine()", "no lease"));
    const res = await call("start", { args: [[]] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: { name: "EngineNotInThisProcessError", message: "getEngine(): no lease" },
    });
  });

  it.each(["forceFlatDeployment", "nudgeClosingGuard"])(
    "refuses %s with 503 once this process has lost the lease, and calls nothing",
    async (method) => {
      // A process paused past the lease's freshness window can still be
      // reached by the web side; the account is the new holder's.
      h.leaseHeld = false;
      const res = await call(method, { args: ["d4"] });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        ok: false,
        error: { name: "EngineNotInThisProcessError", message: expect.stringContaining("no longer holds the engine lease") },
      });
      expect(h.handle[method]).not.toHaveBeenCalled();
    },
  );

  it("answers a read without the lease: only the order-reaching calls are refused", async () => {
    h.leaseHeld = false;
    h.handle.getLogsByLevel.mockResolvedValue({});
    expect((await call("getLogsByLevel", { args: [1] })).status).toBe(200);
  });

  it("answers a non-Error throw as its text", async () => {
    h.handle.start.mockRejectedValue("plain");
    const res = await call("start", { args: [[]] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: { name: "Error", message: "plain" } });
  });
});
