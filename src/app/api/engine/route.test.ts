import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `POST /api/engine` over a row whose playbook this build does not register.
 *
 * Every board resync posts the whole deployment list, and a prod build
 * registers only the allowlist in `strategies/prod-playbooks.ts` — so a check
 * here refusing the start or update over one such row would refuse every board
 * press on prod. The engine refuses the row itself, once, at activation.
 */

const h = vi.hoisted(() => ({
  engine: {
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    sync: vi.fn(),
    getMarketHubStatus: vi.fn(() => ({ mode: "realtime", autoRetry: true, lastDisconnectReason: null })),
    getSeamHealth: vi.fn(() => ({})),
    getSetupReadings: vi.fn(() => ({ "depl-orb": "Range 21,410–21,452 set · waiting on a 5m close past either side." })),
  },
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(() => null) }));
vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => null),
  listClosingDeployments: vi.fn(() => []),
  listManagedDeployments: vi.fn(() => []),
}));
vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngine: vi.fn(async () => h.engine),
  getTopstepClientIfConfigured: vi.fn(async () => null),
  getLogsByLevel: vi.fn(),
  clearAllLogs: vi.fn(),
}));
vi.mock("@/lib/trading/engine/boot/boot-assertion", () => ({
  getBootAssertionState: vi.fn(() => "passed"),
  getBootAssertionFailureReason: vi.fn(() => null),
}));
vi.mock("@/lib/trading/broker-access/staging-allowlist", () => ({
  getStagingAllowlist: vi.fn(() => null),
}));
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  autoTradeVerdictForAccountId: vi.fn(() => ({ permitted: true })),
  getAccountBrokerOrTopstep: vi.fn(() => "topstep"),
}));
vi.mock("@/lib/logger", () => ({ log: { event: vi.fn() } }));

import { POST } from "./route";
import { getDeployment } from "@/lib/db/deployments";
import { AccountEntryGate } from "@/lib/trading/engine/engine-account-entry-gate";

const unregistered = {
  id: "depl-ema",
  accountId: 1,
  ticker: "/MNQ",
  strategyKey: "ema-bounce",
  status: "Active",
  paramValues: {},
  groupId: "grp-ema",
  deletedAt: null,
};

function post(action: "start" | "update") {
  return new NextRequest("http://localhost/api/engine", {
    method: "POST",
    body: JSON.stringify({ action, deployments: [unregistered], practiceOnly: false }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/engine with a row this build does not register", () => {
  it("passes it to the engine on update rather than refusing the batch", async () => {
    const res = await POST(post("update"));

    expect(res.status).toBe(200);
    expect(h.engine.sync).toHaveBeenCalledWith([unregistered]);
  });

  it("passes it to the engine on start too", async () => {
    const res = await POST(post("start"));

    expect(res.status).toBe(200);
    expect(h.engine.start).toHaveBeenCalledWith([unregistered]);
  });
});

// A75 / review of fc3192d7 #1: the board's resync posts the whole list after
// every mutation, so a detached `Active` row arrives here in the body. The
// engine's entry gate reads the marker from the database row, so a body that
// omits or clears it cannot arm the row.
describe("POST /api/engine with a detached Active row in the body", () => {
  const detached = { ...unregistered, id: "depl-detached", strategyKey: "orb", orphanReason: null };

  it.each(["start", "update"] as const)("opens no entry for it on %s", async (action) => {
    vi.mocked(getDeployment).mockImplementation(
      (id) => (id === detached.id ? { ...detached, orphanReason: "account_unavailable_at_boot" } : null) as never,
    );
    const res = await POST(
      new NextRequest("http://localhost/api/engine", {
        method: "POST",
        body: JSON.stringify({ action, deployments: [detached], practiceOnly: false }),
      }),
    );

    expect(res.status).toBe(200);
    const call = (action === "start" ? h.engine.start : h.engine.sync).mock.calls[0] as unknown[];
    const handed = call[0] as Array<{ id: string; accountId: number }>;
    // The row reaches the engine — it stays in the exit loop — and the
    // engine's entry gate refuses it.
    expect(handed.map((d) => d.id)).toEqual([detached.id]);
    // Wired as engine.ts wires it: the marker off the stored row by id.
    const gate = new AccountEntryGate({
      readState: () => null,
      readOrphanReason: (id) => getDeployment(id)?.orphanReason ?? null,
      announce: vi.fn(),
    });
    expect(gate.skipsEntry(handed[0].id, handed[0].accountId, new Date())).toBe(true);
  });
});

describe("POST /api/engine status", () => {
  it("answers the engine's setup readings — the read the setupsChanged frame sends the browser to", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/engine", {
        method: "POST",
        body: JSON.stringify({ action: "status" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { setups?: unknown };
    expect(body.setups).toEqual({
      "depl-orb": "Range 21,410–21,452 set · waiting on a 5m close past either side.",
    });
  });
});
