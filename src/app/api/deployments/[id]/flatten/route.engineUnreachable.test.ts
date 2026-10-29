/**
 * The per-deployment flatten in a `web` process, when the engine process gave
 * no answer or answered with an error. The call may still have run there — a
 * timeout included — so the route must not answer a bare 500 and must not
 * claim nothing was closed: it answers 200 on the route's one channel with the
 * board's `result` shape, `positionMayStillBeOpen` set, and reports the
 * failed flatten the way the engine-down arm does.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => null),
}));

vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const h = vi.hoisted(() => ({
  taggedEvent: vi.fn(),
  forceFlatDeployment: vi.fn(),
}));

vi.mock("@/lib/logging/pipe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/pipe")>()),
  taggedEvent: h.taggedEvent,
}));

// A stubbed remote handle: the chooser's own error predicates stay real.
vi.mock("@/lib/trading/engine/handle/select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/engine/handle/select")>()),
  engineHandle: () => ({ forceFlatDeployment: h.forceFlatDeployment }),
}));

import { POST } from "./route";
import { getDeployment } from "@/lib/db/deployments";
import { EngineRemoteError, EngineUnreachableError } from "@/lib/trading/engine/handle/remote";
import type { ForceFlatResult } from "@/lib/trading/engine/flatten/engine-force-flat";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";

const DEPL = "dep-1";
const ctx = { params: Promise.resolve({ id: DEPL }) };
const NO_ANSWER = "no answer from the engine — check the position";
const REFUSED = "the engine refused the flatten — check the position";

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/deployments/${DEPL}/flatten`, {
    method: "POST",
    headers: { "x-session-token": "tok" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/deployments/[id]/flatten when the engine process cannot answer for it", () => {
  it.each([
    ["a refused connection", new EngineUnreachableError("forceFlatDeployment", "connect ECONNREFUSED"), NO_ANSWER],
    ["a timeout", new EngineUnreachableError("forceFlatDeployment", "timed out after 60000 ms"), NO_ANSWER],
    ["no engine lease", new EngineRemoteError("EngineNotInThisProcessError", "no lease", 503), REFUSED],
    ["a wrong role", new EngineRemoteError("Error", "not found", 404), REFUSED],
    ["a throw on the engine side", new EngineRemoteError("Error", "boom", 500), REFUSED],
  ])("answers 200 with the position possibly open on %s", async (_label, err, reason) => {
    h.forceFlatDeployment.mockRejectedValue(err);

    const res = await POST(makeRequest(), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      result: {
        deploymentId: DEPL,
        accountId: null,
        contractId: null,
        status: "error",
        reason,
        positionMayStillBeOpen: true,
      } satisfies ForceFlatResult,
    });
  });

  it.each([
    ["no answer", new EngineUnreachableError("forceFlatDeployment", "timed out")],
    ["a refusal", new EngineRemoteError("EngineNotInThisProcessError", "no lease", 503)],
  ])("reports %s as the failed flatten, and reads no row to decide", async (_label, err) => {
    h.forceFlatDeployment.mockRejectedValue(err);

    await POST(makeRequest(), ctx);

    expect(h.taggedEvent).toHaveBeenCalledTimes(1);
    const [event, , message, subject] = h.taggedEvent.mock.calls[0] as [string, string, string, { deploymentId?: string }];
    expect(event).toBe("deployment_flatten_failed");
    expect(subject.deploymentId).toBe(DEPL);
    expect(message).toMatch(/may still be open/i);
    expect(getDeployment).not.toHaveBeenCalled();
  });

  it("releases the shutdown drain's count once the call fails", async () => {
    h.forceFlatDeployment.mockRejectedValue(new EngineUnreachableError("forceFlatDeployment", "timed out"));

    await POST(makeRequest(), ctx);

    expect(orderRequestsInFlight()).toBe(0);
  });

  it("leaves any other failure as it was", async () => {
    h.forceFlatDeployment.mockRejectedValue(new Error("boom"));

    await expect(POST(makeRequest(), ctx)).rejects.toThrow("boom");
    expect(h.taggedEvent).not.toHaveBeenCalled();
  });
});
