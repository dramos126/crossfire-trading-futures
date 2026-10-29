/**
 * The factory reset's `deploymentsChanged` emit.
 *
 * The rule this route was the last exception to: **every lifecycle mutation
 * emits, and the unit is the mutation.** A wipe is a mutation of the whole
 * deployment set, and the recorded reason it did not emit — that the wipe
 * kills every stream and the setup guard redirects — was false on both
 * halves, so a second tab rendered rows deleted from SQLite indefinitely.
 *
 * Two properties, and the second is the one the DELETE site's ordering rule
 * already carries: it emits **below** the transaction, so a listener's
 * refetch cannot read rows one statement from being deleted; and a reset that
 * *failed* announces nothing, because a frame is a claim that the set changed.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

const run = vi.fn();

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => ({
    transaction: vi.fn((fn: () => void) => fn),
    prepare: vi.fn(() => ({ run, get: vi.fn() })),
  })),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real. The two
// wipe-side writers are stubbed as well — the real ones reach the DB double
// above, which would make the ordering assertion read a mock's mock.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
  clearSession: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("@/lib/db/web-account", () => ({ clearWebAccount: vi.fn() }));

vi.mock("@/lib/db/settings-cache", () => ({
  invalidateSettingsCache: vi.fn(),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(() => null),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(),
}));

import { POST } from "./route";
import { clearSession } from "@/lib/db/auth";
import { clearWebAccount } from "@/lib/db/web-account";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { EventBroadcaster } from "@/lib/realtime/event-broadcaster";
import type { BroadcastEvent, BroadcasterDeps } from "@/lib/realtime/event-broadcaster";
import { getDb } from "@/lib/db/connection";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/settings/reset", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": "test" },
    body: JSON.stringify(body),
  });
}

describe("the deployment lifecycle event on /api/settings/reset", () => {
  let seen: BroadcastEvent[];
  let subscriber: Mock<(event: BroadcastEvent) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    const broadcaster = new EventBroadcaster({
      userEvents: {
        retain: async () => {},
        isConnected: () => true,
        onPosition: () => {},
        onFill: () => {},
        onStatus: () => {},
      },
      marketTrades: { subscribe: async () => {}, unsubscribe: async () => {} },
      marketDataContractId: async () => null,
    } satisfies BroadcasterDeps);
    seen = [];
    // A spy rather than a bare closure so `invocationCallOrder` is available
    // to the ordering assertion below.
    subscriber = vi.fn((e: BroadcastEvent) => {
      seen.push(e);
    });
    // The route's own log lines ride the same relay; this file is about the
    // lifecycle frame.
    broadcaster.subscribe("board", (e) => {
      if (e.kind !== "logLine") subscriber(e);
    });
    vi.mocked(peekBroadcaster).mockReturnValue(broadcaster);
  });

  it("announces the wipe to every other tab", async () => {
    const res = await POST(request({ confirm: "RESET" }));

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ kind: "deploymentsChanged" }]);
  });

  it("emits below the transaction, not inside it", async () => {
    // `clearSession()` is the last statement in the wipe. A listener that
    // refetches on this frame must not be able to read rows that are one
    // statement from being deleted.
    await POST(request({ confirm: "RESET" }));

    expect(vi.mocked(clearSession).mock.invocationCallOrder[0]).toBeLessThan(
      subscriber.mock.invocationCallOrder[0],
    );
  });

  it("wipes the sign-in account inside the wipe, so first run can create a new one", async () => {
    await POST(request({ confirm: "RESET" }));

    expect(clearWebAccount).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearWebAccount).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(clearSession).mock.invocationCallOrder[0],
    );
  });

  it("says nothing when the wipe throws", async () => {
    // A frame is a claim that the deployment set changed. The route answers
    // 500 with the DB untouched behind it, so there is nothing to announce
    // and a refetch would only cost every connected tab a round trip.
    vi.mocked(getDb).mockReturnValueOnce({
      transaction: () => {
        throw new Error("database is locked");
      },
    } as never);

    const res = await POST(request({ confirm: "RESET" }));

    expect(res.status).toBe(500);
    expect(seen).toEqual([]);
  });

  it("says nothing when the confirmation is missing", async () => {
    const res = await POST(request({ confirm: "nope" }));

    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("survives a null broadcaster, which is the ordinary pre-boot state", async () => {
    vi.mocked(peekBroadcaster).mockReturnValue(null);

    const res = await POST(request({ confirm: "RESET" }));

    expect(res.status).toBe(200);
  });
});
