/**
 * `POST /api/engine` in a `web` process when the engine process gave no
 * answer: 503 with the error's own message, never a bare 500 — for the call
 * the action makes, for the boot-assertion read every action starts with, and
 * for the practice-only roster, whose own catch answers 500 for a Topstep
 * failure but not for this.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  handle: {
    getBootAssertionState: vi.fn(),
    getBootAssertionFailureReason: vi.fn(),
    isRunning: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
    ensureEngine: vi.fn(),
    listTopstepAccounts: vi.fn(),
    getStagingAllowlist: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(() => null) }));
vi.mock("@/lib/db/deployments", () => ({
  listClosingDeployments: vi.fn(() => []),
  listManagedDeployments: vi.fn(() => []),
}));
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  autoTradeVerdictForAccountId: vi.fn(() => ({ permitted: true })),
  getAccountBrokerOrTopstep: vi.fn(() => "topstep"),
}));
vi.mock("@/lib/logger", () => ({ log: { event: vi.fn() } }));

// A stubbed remote handle: the chooser's own error predicate stays real.
vi.mock("@/lib/trading/engine/handle/select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/engine/handle/select")>()),
  engineHandle: () => h.handle,
}));

import { POST } from "./route";
import { EngineUnreachableError } from "@/lib/trading/engine/handle/remote";

const DEPLOYMENT = {
  id: "depl-orb",
  accountId: 1,
  ticker: "/MNQ",
  strategyKey: "orb",
  status: "Active",
  paramValues: {},
  groupId: "grp-orb",
  deletedAt: null,
};

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/engine", { method: "POST", body: JSON.stringify(body) });
}

function unreachable(call: string): EngineUnreachableError {
  return new EngineUnreachableError(call, "timed out after 10000 ms");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.handle.getBootAssertionState.mockResolvedValue("passed");
  h.handle.ensureEngine.mockResolvedValue(undefined);
  h.handle.getStagingAllowlist.mockResolvedValue(null);
  h.handle.listTopstepAccounts.mockResolvedValue([]);
});

describe("POST /api/engine with no answer from the engine process", () => {
  it.each([
    ["status", "status", { action: "status" }],
    ["start", "start", { action: "start", deployments: [DEPLOYMENT], practiceOnly: false }],
    ["stop", "stop", { action: "stop" }],
  ] as const)("answers 503 with the message when %s gets no answer", async (_label, method, body) => {
    const err = unreachable(method);
    h.handle[method].mockRejectedValue(err);

    const res = await POST(post(body));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: err.message });
  });

  it("answers 503 when the first read, the boot assertion, gets no answer", async () => {
    h.handle.getBootAssertionState.mockRejectedValue(unreachable("getBootAssertionState"));

    const res = await POST(post({ action: "status" }));

    expect(res.status).toBe(503);
  });

  it("answers 503, not the practice-only check's 500, when the roster gets no answer", async () => {
    h.handle.listTopstepAccounts.mockRejectedValue(unreachable("listTopstepAccounts"));

    const res = await POST(post({ action: "start", deployments: [DEPLOYMENT] }));

    expect(res.status).toBe(503);
    expect(h.handle.start).not.toHaveBeenCalled();
  });

  it("leaves any other failure as it was", async () => {
    h.handle.status.mockRejectedValue(new Error("engine build failed"));

    await expect(POST(post({ action: "status" }))).rejects.toThrow("engine build failed");
  });
});

// The operator pressed Stop, pushed a UI-only change, and the dashboard's
// first status read must not restart trading from the web process.
describe("POST /api/engine's auto-start in a web process", () => {
  async function freshRoute(): Promise<typeof import("./route")> {
    vi.resetModules();
    return import("./route");
  }

  beforeEach(async () => {
    vi.stubEnv("CROSSFIRE_ROLE", "web");
    const { listManagedDeployments } = await import("@/lib/db/deployments");
    vi.mocked(listManagedDeployments).mockReturnValue([DEPLOYMENT as never]);
    h.handle.isRunning.mockResolvedValue(false);
    h.handle.status.mockResolvedValue({ running: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never asks the engine to start", async () => {
    const route = await freshRoute();

    const res = await route.POST(post({ action: "status" }));

    expect(res.status).toBe(200);
    expect(h.handle.start).not.toHaveBeenCalled();
    expect(h.handle.isRunning).not.toHaveBeenCalled();
  });

  it("still refuses every action when the boot assertion failed", async () => {
    h.handle.getBootAssertionState.mockResolvedValue("failed");
    h.handle.getBootAssertionFailureReason.mockResolvedValue("bad env");
    const route = await freshRoute();

    const res = await route.POST(post({ action: "status" }));

    expect(res.status).toBe(503);
    expect(h.handle.start).not.toHaveBeenCalled();
  });

  it("starts from the database in a process that runs the engine", async () => {
    vi.stubEnv("CROSSFIRE_ROLE", "all");
    const route = await freshRoute();

    await route.POST(post({ action: "status" }));

    expect(h.handle.start).toHaveBeenCalledTimes(1);
  });
});
