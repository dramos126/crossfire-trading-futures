/**
 * Removing the final leg is refused, not a delete.
 *
 * The rule has two halves and this file is the server one. Deleting a whole
 * deployment as a side effect of subtracting a row in an edit screen is a
 * surprise, and `DELETE /api/groups/[id]` carries its own confirm, its own
 * open-position gate across every leg, and the `Destroying` path — none of
 * which should be reachable by subtraction.
 *
 * **The last-leg cascade is not deleted by that refusal**, and the second
 * block below is why: it stops being the single-caller path and becomes the
 * concurrent-removal backstop. Two removals racing on a two-leg deployment
 * both see two legs, both pass the count, and one of them lands on zero. It
 * is the only thing that stops an empty shell, and under one shape it is
 * exercised far more often than it was.
 *
 * The mock set is `groups/[id]/route.test.ts`'s, narrowed to what this route
 * touches — the open-position lookup is stubbed for the same reason it is
 * there: the broker answer has to be a fixture rather than whichever mock
 * throws first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Deployment } from "@/lib/trading/domain";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => ({ transaction: (fn: () => void) => fn })),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const GROUP = {
  id: "grp-1",
  name: null,
  strategyKey: "orb",
  ticker: "/MNQ",
  enabled: true,
  deletedAt: null,
  paramValues: {},
};

function leg(id: string, accountId: number): Deployment {
  return {
    id,
    strategyKey: "orb",
    accountId,
    ticker: "/MNQ",
    contractId: null,
    status: "Active",
    paramValues: {},
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T12:00:00.000Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: "grp-1",
    enabledSnapshot: null,
  };
}

const LEG_A = leg("leg-a", 5001);
const LEG_B = leg("leg-b", 5002);

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(() => GROUP),
  softDeleteGroup: vi.fn(() => GROUP),
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => LEG_A),
  listGroupLegs: vi.fn(() => [LEG_A, LEG_B]),
  listManagedDeployments: vi.fn(() => []),
  softDeleteDeployment: vi.fn(() => true),
}));

vi.mock("@/lib/trading/broker-access/open-position-lookup", () => ({
  createOpenPositionLookup: vi.fn(() => vi.fn(async () => [])),
  hasOpenPositionOnBroker: vi.fn(async () => false),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(() => null),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => null),
}));

import { POST } from "./route";
import { listGroupLegs, softDeleteDeployment } from "@/lib/db/deployments";
import { softDeleteGroup } from "@/lib/db/deployment-groups";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/groups/grp-1/remove-leg/leg-a", {
    method: "POST",
    headers: { "x-session-token": "test" },
  });
}

const ctx = { params: Promise.resolve({ id: "grp-1", legId: "leg-a" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listGroupLegs).mockReturnValue([LEG_A, LEG_B]);
  vi.mocked(softDeleteDeployment).mockReturnValue(true);
});

describe("removing the final leg", () => {
  it("409s and points at Delete instead of removing it", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([LEG_A]);

    const res = await POST(request(), ctx);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("delete the deployment");
    expect(vi.mocked(softDeleteDeployment)).not.toHaveBeenCalled();
    expect(vi.mocked(softDeleteGroup)).not.toHaveBeenCalled();
  });

  it("removes a leg while another remains", async () => {
    const res = await POST(request(), ctx);

    expect(res.status).toBe(200);
    expect(vi.mocked(softDeleteDeployment)).toHaveBeenCalledWith("leg-a");
  });
});

describe("the last-leg cascade survives as the concurrent-removal backstop", () => {
  it("soft-deletes the parent when a racing removal took the other leg", async () => {
    // Both callers read two legs and both pass the refusal above. The
    // second one's post-removal read is what finds zero — unreachable by a
    // single caller, and the only thing that stops an empty shell.
    vi.mocked(listGroupLegs)
      .mockReturnValueOnce([LEG_A, LEG_B]) // the refusal's read
      .mockReturnValueOnce([]); // after this removal, the racer's already landed

    const res = await POST(request(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ groupSoftDeleted: true });
    expect(vi.mocked(softDeleteGroup)).toHaveBeenCalledWith("grp-1");
  });
});
