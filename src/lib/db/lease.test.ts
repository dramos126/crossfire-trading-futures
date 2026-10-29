/**
 * The engine lease's storage: who may take it, what a renew and a release
 * may touch, and the one reader every engine door asks. Real in-memory
 * better-sqlite3 with the migration captured and replayed, the pattern
 * `engine-restart.test.ts` beside it uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations, logEvent } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
  logEvent: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

vi.mock("@/lib/logger", () => ({ log: { event: logEvent } }));

import {
  acceptHandoff,
  handoffAcceptedBy,
  handoffRequestedBy,
  holdsLease,
  leaseGate,
  leaseHolderId,
  readLease,
  refreshHandoffRequest,
  releaseLease,
  releaseLeaseForExit,
  renewLease,
  reportLeaseRefused,
  requestHandoff,
  tryAcquireLease,
  withdrawHandoff,
  HANDOFF_REQUEST_FRESH_MS,
  LEASE_FRESH_MS,
} from "./lease";
import { getDb } from "@/lib/db/connection";

const A = "host-a:1:aaaa";
const B = "host-b:2:bbbb";
const C = "host-c:3:cccc";
const T0 = 1_000_000;
const RELEASED_FOR_EXIT_KEY = "__crossfireEngineLeaseReleasedForExit";

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  logEvent.mockClear();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[RELEASED_FOR_EXIT_KEY];
});

describe("tryAcquireLease", () => {
  it("takes an empty lease as generation 1", () => {
    expect(tryAcquireLease(A, T0)).toEqual({ acquired: true, holder: A, generation: 1, renewedAt: T0 });
    expect(readLease()).toEqual({
      holder: A,
      generation: 1,
      acquiredAt: T0,
      renewedAt: T0,
      handoffRequestedBy: null,
      handoffRequestedAt: null,
    });
  });

  it("refuses a fresh lease another process holds, and leaves it untouched", () => {
    tryAcquireLease(A, T0);
    expect(tryAcquireLease(B, T0 + LEASE_FRESH_MS)).toEqual({
      acquired: false,
      holder: A,
      generation: 1,
      renewedAt: T0,
    });
    expect(readLease()).toMatchObject({ holder: A, generation: 1, renewedAt: T0 });
  });

  it("takes a stale lease with a new generation", () => {
    tryAcquireLease(A, T0);
    const now = T0 + LEASE_FRESH_MS + 1;
    expect(tryAcquireLease(B, now)).toEqual({ acquired: true, holder: B, generation: 2, renewedAt: now });
    expect(readLease().acquiredAt).toBe(now);
  });

  it("re-takes its own lease as a renew, keeping the generation", () => {
    tryAcquireLease(A, T0);
    expect(tryAcquireLease(A, T0 + 1_000)).toMatchObject({ acquired: true, generation: 1, renewedAt: T0 + 1_000 });
    expect(readLease().acquiredAt).toBe(T0);
  });

  it("takes a released lease at once, with a new generation", () => {
    tryAcquireLease(A, T0);
    releaseLease(A);
    expect(tryAcquireLease(B, T0 + 1)).toMatchObject({ acquired: true, generation: 2 });
  });

  it("does not read a held lease with an unreadable renewal time as stale", () => {
    tryAcquireLease(A, T0);
    db.prepare(`UPDATE engine_lease SET renewed_at = 'yesterday' WHERE id = 1`).run();
    expect(tryAcquireLease(B, T0 + 10 * LEASE_FRESH_MS).acquired).toBe(false);
  });
});

describe("renewLease", () => {
  it("re-stamps a lease that is still ours", () => {
    tryAcquireLease(A, T0);
    expect(renewLease(A, T0 + 5_000)).toBe(true);
    expect(readLease().renewedAt).toBe(T0 + 5_000);
  });

  it("returns false once another process has taken it, and writes nothing", () => {
    tryAcquireLease(A, T0);
    tryAcquireLease(B, T0 + LEASE_FRESH_MS + 1);
    expect(renewLease(A, T0 + LEASE_FRESH_MS + 2)).toBe(false);
    expect(readLease()).toMatchObject({ holder: B, renewedAt: T0 + LEASE_FRESH_MS + 1 });
  });
});

describe("releaseLease", () => {
  it("clears our own lease", () => {
    tryAcquireLease(A, T0);
    expect(releaseLease(A)).toBe(true);
    expect(readLease()).toMatchObject({ holder: null, renewedAt: null, generation: 1 });
  });

  it("never clears another holder's", () => {
    tryAcquireLease(A, T0);
    expect(releaseLease(B)).toBe(false);
    expect(readLease()).toMatchObject({ holder: A, renewedAt: T0 });
  });
});

describe("holdsLease", () => {
  it("answers for this process's own holder id", () => {
    expect(holdsLease()).toBe(false);
    tryAcquireLease(leaseHolderId(), T0);
    expect(holdsLease()).toBe(true);
    tryAcquireLease(B, T0 + LEASE_FRESH_MS + 1);
    expect(holdsLease()).toBe(false);
  });

  it("keeps one holder id for the life of the process", () => {
    expect(leaseHolderId()).toBe(leaseHolderId());
    expect(leaseHolderId()).toMatch(/^.+:\d+:[0-9a-f]+$/);
  });

  it("answers no when the row cannot be read", () => {
    tryAcquireLease(leaseHolderId(), T0);
    db.close();
    expect(holdsLease()).toBe(false);
  });

  it("answers no without reading once the exit has released it, and the row is free", () => {
    // Until then it reads: the lease is held through a stop's drain, so a
    // sweep's flatten in the drain is still the engine's.
    tryAcquireLease(leaseHolderId(), T0);
    expect(holdsLease()).toBe(true);

    expect(releaseLeaseForExit()).toBe(true);
    vi.mocked(getDb).mockClear();
    expect(holdsLease()).toBe(false);
    expect(getDb).not.toHaveBeenCalled();
    expect(readLease().holder).toBeNull();
  });
});

describe("leaseGate", () => {
  it("passes while the lease is held and says a loss once, not once per pass", () => {
    const gate = leaseGate("the closing guard", "The flatten is left to the holder.");
    tryAcquireLease(leaseHolderId(), T0);
    expect(gate()).toBe(true);

    tryAcquireLease(B, T0 + LEASE_FRESH_MS + 1);
    expect([gate(), gate(), gate()]).toEqual([false, false, false]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    const [event, , message] = logEvent.mock.calls[0];
    expect(event).toBe("engine_lease_refused");
    expect(message).toContain("the closing guard");
    expect(message).toContain(B);
  });
});

describe("the hand-off request", () => {
  it("is written only on a fresh lease another process holds", () => {
    expect(requestHandoff(B, T0)).toEqual({ kind: "take" });
    tryAcquireLease(B, T0);
    expect(requestHandoff(B, T0 + 1)).toEqual({ kind: "take" });
    expect(requestHandoff(C, T0 + LEASE_FRESH_MS + 1)).toEqual({ kind: "take" });
    expect(readLease().handoffRequestedBy).toBeNull();

    expect(requestHandoff(C, T0 + 1)).toEqual({ kind: "requested", holder: B, generation: 1 });
    expect(readLease()).toMatchObject({ holder: B, handoffRequestedBy: C, handoffRequestedAt: T0 + 1 });
  });

  it("never writes over another standby's live request: the second queues, the first keeps its own", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    expect(requestHandoff(C, T0 + 2)).toEqual({ kind: "queued", behind: B, holder: A });
    expect(readLease()).toMatchObject({ handoffRequestedBy: B, handoffRequestedAt: T0 + 1 });
    // So the first's refresh still lands, and is never read as an acceptance.
    expect(refreshHandoffRequest(B, T0 + 3)).toBe(true);
    expect(handoffAcceptedBy(A)).toBe(false);
  });

  it("lets a second standby ask over a request its asker let lapse", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    const lapsed = T0 + 1 + HANDOFF_REQUEST_FRESH_MS + 1;
    expect(requestHandoff(C, lapsed)).toEqual({ kind: "requested", holder: A, generation: 1 });
    // The first's refresh now fails, and the column says it was not accepted.
    expect(refreshHandoffRequest(B, lapsed + 1)).toBe(false);
    expect(handoffAcceptedBy(A)).toBe(false);
  });

  it("reads an acceptance only as the column clear on the active's own lease", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    expect(handoffAcceptedBy(A)).toBe(false);
    acceptHandoff(A, B, T0 + 2);
    expect(handoffAcceptedBy(A)).toBe(true);
    // Released and taken by another: clear, but not A's acceptance any more.
    releaseLease(A);
    tryAcquireLease(C, T0 + 3);
    expect(handoffAcceptedBy(A)).toBe(false);
  });

  it("never lets the asker take the fresh lease it asked for", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    expect(tryAcquireLease(B, T0 + 2).acquired).toBe(false);
    expect(readLease().holder).toBe(A);
  });

  it("is read by the holder alone", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    expect(handoffRequestedBy(A, T0 + 2)).toBe(B);
    expect(handoffRequestedBy(B, T0 + 2)).toBeNull();
  });

  it("goes unread once the asker stops refreshing it for the request window, so a dead standby is yielded to only inside it", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    const inside = T0 + 1 + HANDOFF_REQUEST_FRESH_MS;
    expect(handoffRequestedBy(A, inside)).toBe(B);
    const late = inside + 1;
    expect(HANDOFF_REQUEST_FRESH_MS).toBeLessThan(LEASE_FRESH_MS);
    expect(handoffRequestedBy(A, late)).toBeNull();
    expect(acceptHandoff(A, B, late)).toBe(false);

    expect(refreshHandoffRequest(B, late)).toBe(true);
    expect(handoffRequestedBy(A, late)).toBe(B);
    expect(acceptHandoff(A, B, late)).toBe(true);
  });

  it("is accepted once, and the asker learns it by its refresh and withdraw finding nothing", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    expect(acceptHandoff(A, B, T0 + 2)).toBe(true);
    expect(acceptHandoff(A, B, T0 + 2)).toBe(false);
    expect(refreshHandoffRequest(B, T0 + 3)).toBe(false);
    expect(withdrawHandoff(B)).toBe(false);
    expect(readLease()).toMatchObject({ holder: A, handoffRequestedBy: null, handoffRequestedAt: null });
  });

  it("cannot be accepted once the asker withdrew it", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    expect(withdrawHandoff(B)).toBe(true);
    expect(acceptHandoff(A, B, T0 + 2)).toBe(false);
  });

  it("is cleared by the next take, which was addressed to the previous holder", () => {
    tryAcquireLease(A, T0);
    requestHandoff(B, T0 + 1);
    releaseLease(A);
    expect(tryAcquireLease(B, T0 + 2)).toMatchObject({ acquired: true, generation: 2 });
    expect(readLease()).toMatchObject({ handoffRequestedBy: null, handoffRequestedAt: null });
  });
});

describe("reportLeaseRefused", () => {
  it("names the door and the process that holds the lease", () => {
    tryAcquireLease(A, T0);
    reportLeaseRefused("start()");
    expect(logEvent).toHaveBeenCalledTimes(1);
    const [event, , message] = logEvent.mock.calls[0];
    expect(event).toBe("engine_lease_refused");
    expect(message).toContain("start()");
    expect(message).toContain(A);
    expect(message).toContain("nothing was started");
  });
});
