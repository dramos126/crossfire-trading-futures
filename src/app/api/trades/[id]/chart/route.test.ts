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

// `db/trades` registers a migration at import time, so it is enumerated.
vi.mock("@/lib/db/trades", () => ({
  getTradeById: vi.fn(),
  getTradeBars: vi.fn(),
}));

vi.mock("@/lib/db/deployments", () => ({ getDeployment: vi.fn(() => null) }));

// `require.context` registry; vitest has no equivalent.
vi.mock("@/lib/trading/strategies", () => ({ getStrategy: vi.fn(() => null) }));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({ getEngineIfReady: vi.fn(() => null) }));

const retrieveBars = vi.fn();
vi.mock("@/lib/market-data/registry-singleton", () => ({
  marketDataRegistry: { historical: () => ({ retrieveBars }) },
}));

import { GET } from "./route";
import { getTradeById, getTradeBars } from "@/lib/db/trades";

const mockTrade = vi.mocked(getTradeById);
const mockBars = vi.mocked(getTradeBars);

const snapshotBar = { timestamp: "2026-10-19T15:55:00+00:00", open: 1, high: 1, low: 1, close: 1, volume: 1 };
const exitBar = { timestamp: "2026-10-19T16:00:00+00:00", open: 2, high: 2, low: 2, close: 2, volume: 2 };

function snapshot(matureAt: string | null) {
  return { bars: [snapshotBar], timeframe: "5m", capturedAt: "2026-10-19 16:01:38", matureAt };
}

async function get() {
  const req = new NextRequest("http://localhost/api/trades/29/chart", {
    headers: { "x-session-token": "test-token" },
  });
  const res = await GET(req, { params: Promise.resolve({ id: "29" }) });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/trades/[id]/chart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrade.mockReturnValue({
      id: 29,
      strategyKey: "delta-structure-break-mes",
      deploymentId: null,
      contractId: "CON.F.US.MES.Z26",
      entryFilledAt: "2026-10-19T15:30:00.360Z",
      entrySubmittedAt: "2026-10-19T15:30:00.321Z",
      exitFilledAt: "2026-10-19T16:01:38.002Z",
    } as unknown as ReturnType<typeof getTradeById>);
  });

  it("serves a mature snapshot without fetching", async () => {
    mockBars.mockReturnValue(snapshot(null));
    const { body } = await get();
    expect(body.source).toBe("snapshot");
    expect(retrieveBars).not.toHaveBeenCalled();
  });

  it("fetches live for an immature snapshot, which lacks the exit bar, at the snapshot's timeframe", async () => {
    mockBars.mockReturnValue(snapshot("2099-01-01T00:00:00Z"));
    retrieveBars.mockResolvedValue([snapshotBar, exitBar]);
    const { body } = await get();
    expect(body.source).toBe("live");
    expect(body.bars).toHaveLength(2);
    expect(body.timeframe).toBe("5m");
    expect(retrieveBars.mock.calls[0][0]).toMatchObject({ unit: 2, unitNumber: 5 });
  });

  it("falls back to the immature snapshot when the live fetch fails", async () => {
    mockBars.mockReturnValue(snapshot("2099-01-01T00:00:00Z"));
    retrieveBars.mockRejectedValue(new Error("down"));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.source).toBe("snapshot");
  });

  it("falls back to the immature snapshot when the live fetch returns nothing", async () => {
    mockBars.mockReturnValue(snapshot("2099-01-01T00:00:00Z"));
    retrieveBars.mockResolvedValue([]);
    const { body } = await get();
    expect(body.source).toBe("snapshot");
    expect(body.bars).toEqual([snapshotBar]);
  });
});
