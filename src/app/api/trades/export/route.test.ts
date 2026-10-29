import { describe, it, expect, vi, beforeEach } from "vitest";
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

// The seam under test. `db/trades` reaches the migration queue at import
// time, so it is enumerated rather than spread.
vi.mock("@/lib/db/trades", () => ({
  listTradesForExport: vi.fn(() => []),
}));

// Per-broker attribution. Same enumerate-rather-than-spread reason as
// `db/trades`: the module registers a migration at import time.
vi.mock("@/lib/db/account-brokers", () => ({
  getAccountBrokerOrNull: vi.fn(() => "topstep"),
}));

// The strategy registry is `require.context`, which vitest has no equivalent
// for; the route only asks it for a version.
vi.mock("@/lib/trading/strategies", () => ({
  getStrategy: vi.fn(() => ({ version: "2.0.2" })),
}));

import { GET } from "./route";
import { listTradesForExport } from "@/lib/db/trades";
import { validateSession } from "@/lib/db/auth";
import { getStrategy } from "@/lib/trading/strategies";
import type { StrategyTrade } from "@/lib/db/trade-types";

const mockList = vi.mocked(listTradesForExport);
const mockValidateSession = vi.mocked(validateSession);
const mockGetStrategy = vi.mocked(getStrategy);

function makeTrade(over: Partial<StrategyTrade> = {}): StrategyTrade {
  const base = {
    id: 41,
    deploymentId: "deploy-aaa",
    strategyKey: "opening-range-breakout-v2",
    accountId: 1001,
    ticker: "MNQ",
    contractId: "CON.F.US.MNQ.U25",
    side: 0,
    size: 2,
    entryOrderId: 900,
    entryPrice: 21000.25,
    entryFilledAt: "2025-06-02T14:00:03.000Z",
    entrySubmittedAt: "2025-06-02T14:00:01.000Z",
    signalBarTs: "2025-06-02T14:00:00.000Z",
    regimeLabel: "active.expanded",
    regimeClassifierVersion: "1",
    sessionKey: "2025-06-02",
    tpOrderId: 901,
    slOrderId: 902,
    breakEvenMoved: false,
    slMovedToBreakeven: false,
    slTrailEngaged: false,
    exitOrderId: 903,
    exitPrice: 21050.25,
    exitFilledAt: "2025-06-02T15:10:00.000Z",
    exitSubmittedAt: null,
    exitReason: "Take Profit",
    exitReasonCode: "take_profit",
    pnlTicks: 200,
    pnlDollars: 197.52,
    feesDollars: 2.48,
    tickSize: 0.25,
    tickValue: 0.5,
    status: "closed",
    createdAt: "2025-06-02 14:00:01",
    updatedAt: "2025-06-02 15:10:00",
    desiredEntryPrice: 21000,
    entrySlippageTicks: 1,
    entrySlippageDollars: 0.5,
    desiredTpPrice: 21050,
    tpSlippageTicks: 0,
    tpSlippageDollars: 0,
    desiredSlPrice: 20975,
    slSlippageTicks: 0,
    slSlippageDollars: 0,
    desiredTpTicks: 200,
    desiredSlTicks: 100,
    exitApproximated: false,
    exitResolutionSource: "rest",
    exitDetectedAt: "2025-06-02 15:10:00",
    paramSnapshot: { size: 2, atrPeriod: 14 },
    filterSnapshot: null,
    replayResultJson: null,
    engineSessionId: "sess-1",
    deploymentVersionId: "3",
  } satisfies StrategyTrade;
  return { ...base, ...over };
}

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/trades/export${query}`, {
    headers: { "x-session-token": "test-token" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateSession.mockReturnValue(true);
  mockGetStrategy.mockReturnValue({ version: "2.0.2" } as ReturnType<typeof getStrategy>);
  mockList.mockReturnValue([]);
});

describe("GET /api/trades/export", () => {
  it("401s without a valid session, before touching the database", async () => {
    mockValidateSession.mockReturnValue(false);
    const res = await GET(request("?from=2025-06-01&to=2025-06-30"));
    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("400s when the range is missing or not YYYY-MM-DD", async () => {
    expect((await GET(request("?to=2025-06-30"))).status).toBe(400);
    expect((await GET(request("?from=2025-06-01"))).status).toBe(400);
    expect((await GET(request("?from=06/01/2025&to=2025-06-30"))).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("passes the optional filters through and omits them when absent", async () => {
    await GET(request("?from=2025-06-01&to=2025-06-30"));
    expect(mockList).toHaveBeenCalledWith({
      from: "2025-06-01",
      to: "2025-06-30",
      ticker: undefined,
      strategyKey: undefined,
    });

    await GET(request("?from=2025-06-01&to=2025-06-30&ticker=MNQ&strategyKey=orb"));
    expect(mockList).toHaveBeenLastCalledWith({
      from: "2025-06-01",
      to: "2025-06-30",
      ticker: "MNQ",
      strategyKey: "orb",
    });
  });

  it("emits every field the monthly review joins on", async () => {
    mockList.mockReturnValue([makeTrade()]);
    const res = await GET(request("?from=2025-06-01&to=2025-06-30"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.trades[0]).toEqual({
      tradeId: 41,
      environment: "staging",
      deploymentId: "deploy-aaa",
      accountId: 1001,
      strategyKey: "opening-range-breakout-v2",
      strategyVersion: "2.0.2",
      ticker: "MNQ",
      contractId: "CON.F.US.MNQ.U25",
      broker: "topstep",
      side: 0,
      signalBarTs: "2025-06-02T14:00:00.000Z",
      entryTs: "2025-06-02T14:00:03.000Z",
      entryPrice: 21000.25,
      contracts: 2,
      slPrice: 20975,
      tpPrice: 21050,
      slTicks: 100,
      tpTicks: 200,
      exitTs: "2025-06-02T15:10:00.000Z",
      exitPrice: 21050.25,
      exitReason: "take_profit",
      pnlGrossDollars: 200,
      feesDollars: 2.48,
      pnlNetDollars: 197.52,
      paramSnapshot: { size: 2, atrPeriod: 14 },
      riskAnchor: {
        intendedRiskTicks: 100,
        intendedRiskDollars: 100,
        realisedRiskTicks: 101,
        realisedRiskDollars: 101,
        fillMinusTriggerTicks: 1,
      },
      regime: { label: "active.expanded", classifierVersion: "1" },
      brokerOrderIds: { entry: 900, tp: 901, sl: 902, exit: 903 },
    });
  });

  // The whole point of the trigger anchor: the stop stays on the level and
  // the distance from the fill moves with the fill. A favourable fill is the
  // mirror of the adverse one above and has to come back negative, or the
  // monthly review cannot tell the two apart.
  it("reports a favourable fill as a signed improvement and a smaller realised risk", async () => {
    mockList.mockReturnValue([
      makeTrade({ entryPrice: 20999.5, desiredSlPrice: 20975, desiredSlTicks: 100 }),
    ]);
    const body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].riskAnchor).toEqual({
      intendedRiskTicks: 100,
      intendedRiskDollars: 100,
      realisedRiskTicks: 98,
      realisedRiskDollars: 98,
      fillMinusTriggerTicks: -2,
    });
  });

  it("reports a short's risk anchor in the trade's own direction", async () => {
    mockList.mockReturnValue([
      makeTrade({
        side: 1,
        desiredEntryPrice: 21000,
        entryPrice: 20999.5,
        desiredSlPrice: 21025,
        desiredSlTicks: 100,
      }),
    ]);
    const body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    // Filling lower on a short is worse: +2 ticks of slippage, and the stop
    // sitting on the trigger's level is 102 ticks away rather than 100.
    expect(body.trades[0].riskAnchor).toEqual({
      intendedRiskTicks: 100,
      intendedRiskDollars: 100,
      realisedRiskTicks: 102,
      realisedRiskDollars: 102,
      fillMinusTriggerTicks: 2,
    });
  });

  it("emits null signalBarTs for a row written before the column existed", async () => {
    mockList.mockReturnValue([makeTrade({ signalBarTs: null })]);
    const body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].signalBarTs).toBeNull();
  });

  it("emits the regime label off the row and never a fresh classification", async () => {
    // Both null is a row written before the columns existed, and it is a
    // different state from `"unknown"` — which is a label the classifier
    // emits when it fails closed, and which comes through as itself.
    mockList.mockReturnValue([makeTrade({ regimeLabel: null, regimeClassifierVersion: null })]);
    const unlabelled = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(unlabelled.trades[0].regime).toEqual({ label: null, classifierVersion: null });

    mockList.mockReturnValue([makeTrade({ regimeLabel: "unknown" })]);
    const failedClosed = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(failedClosed.trades[0].regime).toEqual({ label: "unknown", classifierVersion: "1" });
  });

  it("recovers gross P&L on a legacy row whose fees were never recorded", async () => {
    mockList.mockReturnValue([makeTrade({ feesDollars: null, pnlDollars: 100 })]);
    const body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].pnlGrossDollars).toBe(100);
    expect(body.trades[0].feesDollars).toBeNull();
  });

  it("leaves gross null rather than guessing when the row has no P&L yet", async () => {
    mockList.mockReturnValue([makeTrade({ pnlDollars: null })]);
    const body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].pnlGrossDollars).toBeNull();
  });

  it("emits the exit code, not the rendered label, and null for an unrecognised one", async () => {
    mockList.mockReturnValue([makeTrade({ exitReasonCode: "strategy_signal:EMA close-through" })]);
    let body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].exitReason).toBe("strategy_signal");

    mockList.mockReturnValue([makeTrade({ exitReasonCode: "Flatten All" })]);
    body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].exitReason).toBeNull();
  });

  it("reports a null strategyVersion when the module is gone rather than failing the export", async () => {
    mockGetStrategy.mockReturnValue(undefined);
    mockList.mockReturnValue([makeTrade()]);
    const body = await (await GET(request("?from=2025-06-01&to=2025-06-30"))).json();
    expect(body.trades[0].strategyVersion).toBeNull();
  });

  it("500s with a fixed string when the query throws, keeping the detail off the wire", async () => {
    mockList.mockImplementation(() => {
      throw new Error("database is locked: /data/trading.db");
    });
    const res = await GET(request("?from=2025-06-01&to=2025-06-30"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to export trades");
  });
});
