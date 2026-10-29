/**
 * `GET /api/regime`. Three things are worth a test and none of them is the
 * happy path's shape: the route is session-gated before it reads anything,
 * the session day defaults to the *Globex* day rather than the calendar one,
 * and the failure arm says nothing about the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// A throwing `getDb` is the enforcement: a handler that reaches the database
// instead of the mocked seam fails loudly rather than needing a fixture.
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

vi.mock("@/lib/db/regime-days", () => ({
  listRegimeDaysForSession: vi.fn(() => []),
}));

import { GET } from "./route";
import { listRegimeDaysForSession, type RegimeDay } from "@/lib/db/regime-days";
import { validateSession } from "@/lib/db/auth";

const mockList = vi.mocked(listRegimeDaysForSession);
const mockValidateSession = vi.mocked(validateSession);

const KNOWN: RegimeDay = {
  ticker: "MNQ",
  sessionDate: "2026-09-08",
  classifierVersion: "1",
  label: "active.compressed",
  features: { vol5: 412.4, vol5Pct: 78, rthRange: 380, rangeRatio: 0.82 },
  vol: "active",
  range: "compressed",
  computedAt: "2026-09-07T21:06:00.000Z",
  source: "nightly",
};

const UNKNOWN: RegimeDay = {
  ...KNOWN,
  ticker: "MES",
  label: "unknown",
  features: null,
  vol: null,
  range: null,
  source: "lazy",
};

function request(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/regime${query}`, {
    headers: { "x-session-token": "test-token" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateSession.mockReturnValue(true);
  mockList.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/regime", () => {
  it("401s without a valid session, before touching the database", async () => {
    mockValidateSession.mockReturnValue(false);
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("400s on a sessionDate that is not YYYY-MM-DD", async () => {
    expect((await GET(request("?sessionDate=09/08/2026"))).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("defaults to the Globex session day, not the calendar day", async () => {
    // 22:30Z on the 7th is 18:30 ET, which is inside the 8th's session.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T22:30:00Z"));
    await GET(request());
    expect(mockList).toHaveBeenCalledWith("2026-09-08", "1");
  });

  it("emits the label, its axes and its features, and `unknown` as itself", async () => {
    mockList.mockReturnValue([UNKNOWN, KNOWN]);
    const body = await (await GET(request("?sessionDate=2026-09-08"))).json();

    expect(body.sessionDate).toBe("2026-09-08");
    expect(body.classifierVersion).toBe("1");
    expect(body.days).toEqual([
      {
        ticker: "MES",
        label: "unknown",
        vol: null,
        range: null,
        classifierVersion: "1",
        features: null,
        computedAt: "2026-09-07T21:06:00.000Z",
        source: "lazy",
      },
      {
        ticker: "MNQ",
        label: "active.compressed",
        vol: "active",
        range: "compressed",
        classifierVersion: "1",
        features: { vol5: 412.4, vol5Pct: 78, rthRange: 380, rangeRatio: 0.82 },
        computedAt: "2026-09-07T21:06:00.000Z",
        source: "nightly",
      },
    ]);
  });

  it("answers an empty list rather than a 404 when nothing has labelled the day", async () => {
    const res = await GET(request("?sessionDate=2026-09-08"));
    expect(res.status).toBe(200);
    expect((await res.json()).days).toEqual([]);
  });

  it("keeps a SQLite message off the wire on failure", async () => {
    mockList.mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: /data/trading.db near SELECT * FROM regime_days");
    });
    const res = await GET(request("?sessionDate=2026-09-08"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to read regime labels" });
  });
});
