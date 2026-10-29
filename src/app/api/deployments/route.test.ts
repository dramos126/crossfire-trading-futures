/**
 * `POST /api/deployments` — the playbook's own cap and share at the create
 * boundary: text that spells a number is stored as the number (the A113
 * shape, for these two settings), and anything the sizer could not use is
 * refused before a row exists. Paused, so the session and conflict checks
 * (stubbed) are not what decides.
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

const h = vi.hoisted(() => ({ insertGroupWithLegs: vi.fn(), getStrategy: vi.fn() }));

// Every contract row is deployable today (A112), so MYM stands in for the next
// research row: the one collaborator that would answer differently.
vi.mock("@/lib/trading/contracts/contract-specs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/contracts/contract-specs")>()),
  DEPLOYABLE_SPEC_TICKERS: ["MNQ", "MES", "MGC"],
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  insertGroupWithLegs: h.insertGroupWithLegs,
}));

vi.mock("@/lib/db/deployments", () => ({
  listDeletedDeployments: vi.fn(() => []),
  listDeployments: vi.fn(() => []),
  findConflictingDeployments: vi.fn(() => []),
  filterMainSessionOverlaps: vi.fn(() => []),
  sessionForStrategyKey: vi.fn(() => null),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  screenAccountsForAutoTrade: vi.fn(() => null),
}));

// Enumerated, not spread: the real module is the `require.context` loader.
vi.mock("@/lib/trading/strategies", () => ({
  crossTimeframeExitRefusalForStrategyKey: vi.fn(() => null),
  daySessionRefusalForStrategyKey: vi.fn(() => null),
  getStrategy: h.getStrategy,
  instrumentRefusalForStrategyKey: vi.fn(() => null),
}));

vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => null),
}));

import { POST } from "./route";
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
    entryMode: {
      type: "select",
      label: "Entry",
      default: "close",
      options: [
        { value: "close", label: "On the close" },
        { value: "retest", label: "On a retest" },
      ],
    },
  }),
  settingsRefusal: (params: CommonParams) => ((params.emaLength as number) > 50 ? EMA_TOO_LONG : null),
} as Pick<StrategyModule, "params" | "settingsRefusal"> as StrategyModule;

function post(paramValues: Record<string, unknown>, ticker = "/MNQ"): NextRequest {
  return new NextRequest("http://localhost/api/deployments", {
    method: "POST",
    headers: { "x-session-token": "test", "content-type": "application/json" },
    body: JSON.stringify({ strategyKey: "orb", accountId: 5001, ticker, status: "Paused", paramValues }),
  });
}

describe("POST /api/deployments — a research-only instrument (A112)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is refused with the shared sentence and writes nothing", async () => {
    const res = await POST(post({}, "/MYM"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: undeployableInstrumentRefusal("/MYM") });
    expect(undeployableInstrumentRefusal("/MYM")).not.toBeNull();
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });
});

describe("POST /api/deployments — every setting by its declared type (A113)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getStrategy.mockReturnValue(PLAYBOOK);
    h.insertGroupWithLegs.mockReturnValue({ group: { id: "grp-1" }, legs: [{ id: "leg-1" }] });
  });

  it("stores a number sent as text as the number", async () => {
    const res = await POST(post({ emaLength: "21", useLevelExit: "true", entryMode: "retest" }));

    expect(res.status).toBe(200);
    expect(h.insertGroupWithLegs).toHaveBeenCalledWith(
      expect.objectContaining({ paramValues: { emaLength: 21, useLevelExit: true, entryMode: "retest" } }),
      [{ accountId: 5001 }],
    );
  });

  it("refuses text that is no number with a 400 naming the setting", async () => {
    const res = await POST(post({ emaLength: "abc" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Hourly EMA length must be a whole number, and "abc" is not one.');
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });

  it("refuses a boolean or an option that does not convert", async () => {
    expect((await POST(post({ useLevelExit: "yes" }))).status).toBe(400);
    expect((await POST(post({ entryMode: "open" }))).status).toBe(400);
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });

  it("refuses what the playbook's own settings check rejects", async () => {
    const res = await POST(post({ emaLength: "60" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: EMA_TOO_LONG });
    expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
  });
});

describe("POST /api/deployments — the playbook sizing settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.insertGroupWithLegs.mockReturnValue({ group: { id: "grp-1" }, legs: [{ id: "leg-1" }] });
  });

  it("stores a numeric string as the number it spells", async () => {
    const res = await POST(post({ playbookMaxContracts: "1", playbookRiskPercent: "100", cooldownSeconds: 0 }));

    expect(res.status).toBe(200);
    expect(h.insertGroupWithLegs).toHaveBeenCalledWith(
      expect.objectContaining({ paramValues: { playbookMaxContracts: 1, playbookRiskPercent: 100, cooldownSeconds: 0 } }),
      [{ accountId: 5001 }],
    );
  });

  it("takes neither setting, and 0 as no cap", async () => {
    expect((await POST(post({}))).status).toBe(200);
    expect((await POST(post({ playbookMaxContracts: 0 }))).status).toBe(200);
  });

  for (const value of [-1, 1.5, 4, "two", null]) {
    it(`refuses a cap of ${JSON.stringify(value)} and writes nothing`, async () => {
      const res = await POST(post({ playbookMaxContracts: value }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: PLAYBOOK_MAX_CONTRACTS_REFUSAL });
      expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
    });
  }

  for (const value of [0, -10, 101, 12.5, "half"]) {
    it(`refuses a share of ${JSON.stringify(value)} and writes nothing`, async () => {
      const res = await POST(post({ playbookRiskPercent: value }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: PLAYBOOK_RISK_PERCENT_REFUSAL });
      expect(h.insertGroupWithLegs).not.toHaveBeenCalled();
    });
  }
});
