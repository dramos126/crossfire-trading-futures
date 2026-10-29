/**
 * The page-mount orphan cross-check, the third A74 site. It bailed only on a
 * failed Topstep arm and otherwise paused every absent account, so a Tradovate
 * arm that did not answer made opening the deployments page orphan-pause every
 * Tradovate deployment with nothing logged. It now attributes each absent
 * account to its own arm, like boot and the reconciler poll.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const H = vi.hoisted(() => ({
  engine: {
    refreshBrokerRegistry: vi.fn(),
    isAccountRegistered: vi.fn<(accountId: number) => boolean>(() => false),
    handleOrphanedAccount: vi.fn(async () => undefined),
  },
  listManagedDeployments: vi.fn(),
  getAccountBrokerOrNull: vi.fn<(accountId: number) => "topstep" | "tradovate" | null>(),
  logEvent: vi.fn(),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngine: vi.fn(async () => H.engine),
}));
vi.mock("@/lib/db/deployments", () => ({ listManagedDeployments: H.listManagedDeployments }));
vi.mock("@/lib/db/account-brokers", () => ({ getAccountBrokerOrNull: H.getAccountBrokerOrNull }));
// `warn`: the session gate logs the deprecated header once per process.
vi.mock("@/lib/logger", () => ({ log: { event: H.logEvent, warn: vi.fn() } }));

import { POST } from "./route";
import type { RefreshResult } from "@/lib/trading/broker-access/broker-registry";

const TOPSTEP_ACCOUNT = 5001;
const TRADOVATE_ACCOUNT = 7002;
const ANSWERED_AT = "2026-10-14T21:00:00.000Z";

function refresh(errors: Partial<RefreshResult["errors"]> = {}): RefreshResult {
  const full = { topstep: null, tradovate: null, ...errors };
  return {
    partial: full.topstep !== null || full.tradovate !== null,
    errors: full,
    // An answering arm that listed neither test account; a failed one, nothing.
    listed: {
      topstep: full.topstep === null ? [] : null,
      tradovate: full.tradovate === null ? [] : null,
    },
    cannotTrade: {
      topstep: full.topstep === null ? [] : null,
      tradovate: full.tradovate === null ? [] : null,
    },
    answeredAt: {
      topstep: full.topstep === null ? ANSWERED_AT : null,
      tradovate: full.tradovate === null ? ANSWERED_AT : null,
    },
    balances: { topstep: full.topstep === null ? new Map() : null, tradovate: null },
    size: 0,
    removed: [],
    kindChanges: [],
  };
}

function request(): NextRequest {
  return new NextRequest("http://localhost/api/deployments/check-orphans", {
    method: "POST",
    headers: { "x-session-token": "tok" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  H.engine.isAccountRegistered.mockReturnValue(false);
  H.listManagedDeployments.mockReturnValue([
    { accountId: TOPSTEP_ACCOUNT, orphanReason: null },
    { accountId: TRADOVATE_ACCOUNT, orphanReason: null },
  ]);
  H.getAccountBrokerOrNull.mockImplementation((id) =>
    id === TRADOVATE_ACCOUNT ? "tradovate" : "topstep",
  );
});

describe("POST /api/deployments/check-orphans attributes an absent account to a broker arm", () => {
  it("skips the Tradovate account when the Tradovate arm failed, and still orphans the Topstep one", async () => {
    H.engine.refreshBrokerRegistry.mockResolvedValue(refresh({ tradovate: "first login failed" }));

    await POST(request());

    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledTimes(1);
    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      TOPSTEP_ACCOUNT,
      "page_render_account_check",
    );
  });

  it("logs the skip as orphan_check_skipped, naming the account, the arm and the error", async () => {
    H.engine.refreshBrokerRegistry.mockResolvedValue(refresh({ tradovate: "first login failed" }));

    await POST(request());

    const call = H.logEvent.mock.calls.find((c) => c[0] === "orphan_check_skipped");
    expect(call).toBeDefined();
    const line = String(call?.[2]);
    expect(line).toContain(String(TRADOVATE_ACCOUNT));
    expect(line).toContain("tradovate");
    expect(line).toContain("first login failed");
    expect(call?.[3]).toMatchObject({ accountId: TRADOVATE_ACCOUNT });
  });

  it("orphans every absent account on a clean fan-out", async () => {
    H.engine.refreshBrokerRegistry.mockResolvedValue(refresh());

    const res = await POST(request());

    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      TOPSTEP_ACCOUNT,
      "page_render_account_check",
    );
    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      TRADOVATE_ACCOUNT,
      "page_render_account_check",
    );
    expect(await res.json()).toEqual({
      ok: true,
      orphanedAccountIds: [TOPSTEP_ACCOUNT, TRADOVATE_ACCOUNT],
    });
  });

  // What the blanket Topstep bail used to guard, now answered per arm: the
  // Topstep accounts are skipped, and the arm that answered keeps detecting.
  it("skips the Topstep account when the Topstep arm failed, and still orphans the Tradovate one", async () => {
    H.engine.refreshBrokerRegistry.mockResolvedValue(refresh({ topstep: "504 from /Account/search" }));

    await POST(request());

    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledTimes(1);
    expect(H.engine.handleOrphanedAccount).toHaveBeenCalledWith(
      TRADOVATE_ACCOUNT,
      "page_render_account_check",
    );
  });

  it("skips an account with no persisted broker row when the refresh was partial", async () => {
    H.getAccountBrokerOrNull.mockReturnValue(null);
    H.engine.refreshBrokerRegistry.mockResolvedValue(refresh({ topstep: "504" }));

    await POST(request());

    expect(H.engine.handleOrphanedAccount).not.toHaveBeenCalled();
  });

  it("leaves a registered account alone", async () => {
    H.engine.isAccountRegistered.mockReturnValue(true);
    H.engine.refreshBrokerRegistry.mockResolvedValue(refresh());

    await POST(request());

    expect(H.engine.handleOrphanedAccount).not.toHaveBeenCalled();
    expect(H.getAccountBrokerOrNull).not.toHaveBeenCalled();
  });
});
