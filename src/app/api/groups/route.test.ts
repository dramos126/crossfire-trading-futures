/**
 * `GET /api/groups` — the board's read.
 *
 * One property: the response carries each book's own switch and its cells'
 * arming beside the parent rows. The Dashboard hides the card of a book that
 * is switched off and the row of a disarmed playbook, and the rows alone
 * cannot say either — a stood-down row under a book that is *on* may be the
 * armed-but-idle state the operator has to see. So both come from the books
 * tables, and this pins that they are on the wire and read-only.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const GROUP = { id: "grp-1", strategyKey: "orb", ticker: "/MNQ", enabled: false, bookId: "book-1" };

const h = vi.hoisted(() => ({
  setBookEnabled: vi.fn(),
  insertGroupWithLegs: vi.fn(),
  getStrategy: vi.fn(),
}));

// Every contract row is deployable today (A112), so MYM stands in for the next
// research row: the one collaborator that would answer differently.
vi.mock("@/lib/trading/contracts/contract-specs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/contracts/contract-specs")>()),
  DEPLOYABLE_SPEC_TICKERS: ["MNQ", "MES", "MGC"],
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  listGroups: vi.fn(() => [GROUP]),
  insertGroupWithLegs: h.insertGroupWithLegs,
}));

vi.mock("@/lib/db/books", () => ({
  listBooksWithPlaybooks: vi.fn(() => [
    {
      id: "book-1",
      accountId: 5001,
      enabled: false,
      createdAt: 1,
      updatedAt: 2,
      playbooks: [
        { bookId: "book-1", ticker: "/MNQ", strategyKey: "orb", armed: false, updatedAt: 3 },
        { bookId: "book-1", ticker: "/MES", strategyKey: "orb", armed: true, updatedAt: 3 },
      ],
    },
    { id: "book-2", accountId: 5002, enabled: true, createdAt: 1, updatedAt: 2, playbooks: [] },
  ]),
  setBookEnabled: h.setBookEnabled,
}));

vi.mock("@/lib/db/deployments", () => ({
  filterMainSessionOverlaps: vi.fn(() => []),
  findConflictingDeployments: vi.fn(() => []),
  findCrossStrategyDeployments: vi.fn(() => []),
  sessionForStrategyKey: vi.fn(() => null),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  screenAccountsForAutoTrade: vi.fn(() => null),
}));

vi.mock("@/lib/trading/strategies", () => ({
  crossTimeframeExitRefusalForStrategyKey: vi.fn(() => null),
  daySessionRefusalForStrategyKey: vi.fn(() => null),
  getStrategy: h.getStrategy,
  instrumentRefusalForStrategyKey: vi.fn(() => null),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => null),
}));

import { GET, POST } from "./route";
import {
  PLAYBOOK_MAX_CONTRACTS_REFUSAL,
  PLAYBOOK_RISK_PERCENT_REFUSAL,
} from "@/lib/trading/orders/risk-sizer";
import {
  undeployableInstrumentRefusal,
  withCommonParams,
  type CommonParams,
  type StrategyModule,
} from "@/lib/trading/strategy-types";

const EMA_TOO_LONG = "Hourly EMA length above 50 takes no entry: set 50 or less.";

const PLAYBOOK = {
  params: withCommonParams({
    emaLength: { type: "integer", label: "Hourly EMA length", default: 21 },
    useLevelExit: { type: "boolean", label: "Exit at the level", default: false },
  }),
  settingsRefusal: (params: CommonParams) => ((params.emaLength as number) > 50 ? EMA_TOO_LONG : null),
} as Pick<StrategyModule, "params" | "settingsRefusal"> as StrategyModule;

function postGroup(paramValues: Record<string, unknown>, ticker = "/MNQ"): NextRequest {
  return new NextRequest("http://localhost/api/groups", {
    method: "POST",
    headers: { "x-session-token": "test", "content-type": "application/json" },
    body: JSON.stringify({ strategyKey: "orb", ticker, paramValues, enabled: false, legs: [{ accountId: 5001 }] }),
  });
}

describe("POST /api/groups — a research-only instrument (A112)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is refused with the shared sentence and writes nothing", async () => {
    const res = await POST(postGroup({}, "/MYM"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: undeployableInstrumentRefusal("/MYM") });
    expect(undeployableInstrumentRefusal("/MYM")).not.toBeNull();
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });
});

describe("POST /api/groups — every setting by its declared type (A113)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getStrategy.mockReturnValue(PLAYBOOK);
    h.insertGroupWithLegs.mockReturnValue({ group: GROUP, legs: [] });
  });

  it("stores a number sent as text as the number", async () => {
    expect((await POST(postGroup({ emaLength: "21", useLevelExit: "false" }))).status).toBe(200);
    expect(h.insertGroupWithLegs).toHaveBeenCalledWith(
      expect.objectContaining({ paramValues: { emaLength: 21, useLevelExit: false } }),
      [{ accountId: 5001 }],
    );
  });

  it("refuses text that is no number with a 400 naming the setting", async () => {
    const res = await POST(postGroup({ emaLength: "abc" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Hourly EMA length must be a whole number, and "abc" is not one.');
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });

  it("refuses a boolean that does not convert", async () => {
    expect((await POST(postGroup({ useLevelExit: 1 }))).status).toBe(400);
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });

  it("refuses what the playbook's own settings check rejects", async () => {
    const res = await POST(postGroup({ emaLength: 60 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: EMA_TOO_LONG });
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });
});

function get(): NextRequest {
  return new NextRequest("http://localhost/api/groups", {
    headers: { "x-session-token": "test" },
  });
}

describe("GET /api/groups", () => {
  it("answers each book's own switch and its cells' arming beside the parent rows", async () => {
    const body = await (await GET(get())).json();

    expect(body.groups).toEqual([GROUP]);
    expect(body.books).toEqual([
      {
        id: "book-1",
        enabled: false,
        playbooks: [
          { ticker: "/MNQ", strategyKey: "orb", armed: false },
          { ticker: "/MES", strategyKey: "orb", armed: true },
        ],
      },
      { id: "book-2", enabled: true, playbooks: [] },
    ]);
  });

  it("writes nothing", async () => {
    await GET(get());

    expect(h.setBookEnabled).not.toHaveBeenCalled();
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });
});

/** The playbook's own cap and share, at the create boundary. Paused, so the
 *  session and conflict checks (stubbed here) are not what decides. */
describe("POST /api/groups — the playbook sizing settings", () => {
  beforeEach(() => vi.clearAllMocks());

  function post(paramValues: Record<string, unknown>): NextRequest {
    return new NextRequest("http://localhost/api/groups", {
      method: "POST",
      headers: { "x-session-token": "test", "content-type": "application/json" },
      body: JSON.stringify({ strategyKey: "orb", ticker: "/MNQ", paramValues, enabled: false, legs: [{ accountId: 5001 }] }),
    });
  }

  it("stores a numeric string as the number it spells", async () => {
    h.insertGroupWithLegs.mockReturnValueOnce({ group: GROUP, legs: [] });
    await POST(post({ playbookMaxContracts: "1", playbookRiskPercent: "50", cooldownSeconds: 0 }));

    expect(h.insertGroupWithLegs).toHaveBeenCalledWith(
      expect.objectContaining({ paramValues: { playbookMaxContracts: 1, playbookRiskPercent: 50, cooldownSeconds: 0 } }),
      [{ accountId: 5001 }],
    );
  });

  for (const value of [-1, 1.5, 4, "two"]) {
    it(`refuses a cap of ${JSON.stringify(value)} and writes nothing`, async () => {
      const res = await POST(post({ playbookMaxContracts: value }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(PLAYBOOK_MAX_CONTRACTS_REFUSAL);
      expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
    });
  }

  for (const value of [0, 101, 33.3, "half"]) {
    it(`refuses a share of ${JSON.stringify(value)} and writes nothing`, async () => {
      const res = await POST(post({ playbookRiskPercent: value }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(PLAYBOOK_RISK_PERCENT_REFUSAL);
      expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
    });
  }
});
