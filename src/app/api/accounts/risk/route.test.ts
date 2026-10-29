import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// vi.mock() factories are hoisted above every const below, so each one
// must be self-contained.

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// The session gate validates against the DB, which is unreachable here.
// Stub the store seam only, so `requireSession` itself — header name and
// 401 shape — still runs for real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

// The four table functions this route composes, mocked at the seam: the
// property under test is *what the route writes*, so the writes have to be
// observable and the reads have to be able to answer a stored posture.
vi.mock("@/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() },
}));

// The verdict read stays real — the property under test is that the route asks
// the one predicate — so only its catalog query is stubbed, at `getDb`.
vi.mock("@/lib/db/account-brokers", async (importOriginal) => ({
  autoTradeVerdictsOrUnverified: (await importOriginal<typeof import("@/lib/db/account-brokers")>())
    .autoTradeVerdictsOrUnverified,
  getAccountDailyPnlLimits: vi.fn(),
  getAccountRiskPhase: vi.fn(),
  getAccountRiskSettings: vi.fn(),
  listAccountRiskPostures: vi.fn(() => []),
  logAccountRiskChange: vi.fn(),
  setAccountDailyPnlLimits: vi.fn(() => true),
  setAccountRiskPhase: vi.fn(() => true),
  setAccountRiskPosture: vi.fn(() => true),
}));

import { GET, PUT } from "./route";
import { getDb } from "@/lib/db/connection";
import { log } from "@/lib/logger";
import {
  getAccountDailyPnlLimits,
  getAccountRiskPhase,
  getAccountRiskSettings,
  listAccountRiskPostures,
  logAccountRiskChange,
  setAccountDailyPnlLimits,
  setAccountRiskPhase,
  setAccountRiskPosture,
} from "@/lib/db/account-brokers";
import { MAX_CONTRACTS_REFUSAL, REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import {
  COMBINE_MLL_REFUSAL,
  COMBINE_MLL_USD,
  NON_TOPSTEP_PHASE_REFUSAL,
  PAYOUT_PHASE_PATH_REFUSAL,
  POST_PAYOUT_PHASE_REFUSAL,
} from "@/lib/trading/orders/account-phase-sizer";
import {
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
  type AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";

const ACCOUNT_ID = 1001;

/** What the account has stored before the PUT under test: a posture and a
 *  $675 daily loss limit, no profit limit. The loss limit is the value every
 *  partial-write case below is about. */
const STORED = {
  dailyMaxLossUsd: 675,
  dailyMaxProfitUsd: 0,
  dailyPnlIncludeUnrealized: true,
};

/** What the account's phase columns hold before the PUT under test: a Topstep
 *  row that has never been opted in and has never taken a payout. */
const STORED_PHASE = {
  broker: "topstep" as const,
  phase: "off" as const,
  mllUsd: null,
  startBalanceUsd: null,
  pressAtUsd: null,
  payoutTakenAt: null,
};

function makeRequest(body: unknown, token: string | null = "tok-abc"): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["x-session-token"] = token;
  return new NextRequest("http://localhost/api/accounts/risk", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

/** A body that names the posture and nothing else, plus whatever daily keys
 *  the case is about. */
function posture(extra: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT_ID,
    maxRiskPerTradeUsd: 225,
    maxContracts: REVIEWED_MAX_CONTRACTS,
    ...extra,
  };
}

describe("PUT /api/accounts/risk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccountDailyPnlLimits).mockReturnValue({ ...STORED });
    vi.mocked(setAccountRiskPosture).mockReturnValue(true);
    vi.mocked(setAccountDailyPnlLimits).mockReturnValue(true);
    vi.mocked(setAccountRiskPhase).mockReturnValue(true);
    vi.mocked(getAccountRiskPhase).mockReturnValue({ ...STORED_PHASE });
  });

  it("logs the change against the settings read before any write", async () => {
    const before = { posture: null, dailyPnl: { ...STORED }, phase: { ...STORED_PHASE } };
    vi.mocked(getAccountRiskSettings).mockReturnValue(before);

    const res = await PUT(makeRequest(posture({ dailyMaxProfitUsd: 750 })));

    expect(res.status).toBe(200);
    expect(logAccountRiskChange).toHaveBeenCalledWith(ACCOUNT_ID, before, "saved in Settings");
    const read = vi.mocked(getAccountRiskSettings).mock.invocationCallOrder[0];
    const logged = vi.mocked(logAccountRiskChange).mock.invocationCallOrder[0];
    expect(read).toBeLessThan(vi.mocked(setAccountRiskPosture).mock.invocationCallOrder[0]);
    expect(logged).toBeGreaterThan(vi.mocked(setAccountDailyPnlLimits).mock.invocationCallOrder[0]);
  });

  it("logs nothing for a refused save", async () => {
    const res = await PUT(makeRequest(posture({ dailyMaxProfitUsd: -1 })));
    expect(res.status).toBe(400);
    expect(logAccountRiskChange).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await PUT(makeRequest(posture(), null));
    expect(res.status).toBe(401);
    expect(setAccountRiskPosture).not.toHaveBeenCalled();
  });

  // The regression this file exists for: the form posts the posture, the
  // route used to read the absent daily fields as 0, and `<= 0` maps to NULL
  // — a set loss limit disarmed with no error and no log.
  it("leaves a stored daily loss limit alone when the body does not name it", async () => {
    const res = await PUT(makeRequest(posture()));
    expect(res.status).toBe(200);
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(ACCOUNT_ID, {
      dailyMaxLossUsd: 675,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: true,
    });
  });

  it("clears a daily limit the body names as 0", async () => {
    await PUT(makeRequest(posture({ dailyMaxLossUsd: 0 })));
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ dailyMaxLossUsd: 0 }),
    );
  });

  it("clears a daily limit the body names as null", async () => {
    await PUT(makeRequest(posture({ dailyMaxLossUsd: null })));
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ dailyMaxLossUsd: 0 }),
    );
  });

  it("writes a daily limit the body names, and leaves the other side stored", async () => {
    await PUT(makeRequest(posture({ dailyMaxProfitUsd: 400 })));
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(ACCOUNT_ID, {
      dailyMaxLossUsd: 675,
      dailyMaxProfitUsd: 400,
      dailyPnlIncludeUnrealized: true,
    });
  });

  // The Settings form no longer sends the flag at all — the checkbox is gone
  // until a surface reads it — so absence must not flip a stored `true`.
  it("keeps the stored include-unrealized flag when the body omits it", async () => {
    await PUT(makeRequest(posture({ dailyMaxLossUsd: 500 })));
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ dailyPnlIncludeUnrealized: true }),
    );
  });

  it("writes the include-unrealized flag the body names", async () => {
    await PUT(makeRequest(posture({ dailyPnlIncludeUnrealized: false })));
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ dailyPnlIncludeUnrealized: false }),
    );
  });

  it("writes the posture the body names", async () => {
    await PUT(makeRequest(posture()));
    expect(setAccountRiskPosture).toHaveBeenCalledWith(ACCOUNT_ID, {
      maxRiskPerTradeUsd: 225,
      maxContracts: REVIEWED_MAX_CONTRACTS,
    });
  });

  it("accepts a ceiling below the reviewed one", async () => {
    const res = await PUT(makeRequest(posture({ maxContracts: 1 })));
    expect(res.status).toBe(200);
    expect(setAccountRiskPosture).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ maxContracts: 1 }),
    );
  });

  // The sentence, not just the status: it is the only place the operator is
  // told the ceiling is reviewed rather than merely refused, and nothing else
  // fails when it drifts from the constant.
  it("refuses a ceiling above the reviewed one with the shared refusal", async () => {
    const res = await PUT(makeRequest(posture({ maxContracts: REVIEWED_MAX_CONTRACTS + 1 })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: MAX_CONTRACTS_REFUSAL });
    expect(MAX_CONTRACTS_REFUSAL).toContain(String(REVIEWED_MAX_CONTRACTS));
    expect(setAccountRiskPosture).not.toHaveBeenCalled();
  });

  // Both posture fields absent is the Clear button, and it takes the daily
  // gate with it: an account that takes no trades has no day to limit.
  it("clears the posture and the daily gate when both posture fields are absent", async () => {
    await PUT(makeRequest({ accountId: ACCOUNT_ID }));
    expect(setAccountRiskPosture).toHaveBeenCalledWith(ACCOUNT_ID, null);
    expect(setAccountDailyPnlLimits).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it("answers 404 for an account the catalogue does not carry, and writes no daily gate", async () => {
    vi.mocked(setAccountRiskPosture).mockReturnValue(false);
    const res = await PUT(makeRequest(posture()));
    expect(res.status).toBe(404);
    expect(setAccountDailyPnlLimits).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing accountId", { maxRiskPerTradeUsd: 225, maxContracts: 5 }],
    ["a zero budget", posture({ maxRiskPerTradeUsd: 0 })],
    ["a sub-cent budget", posture({ maxRiskPerTradeUsd: 19.999 })],
    ["a fractional contract ceiling", posture({ maxContracts: 1.5 })],
    ["a ceiling above the reviewed one", posture({ maxContracts: REVIEWED_MAX_CONTRACTS + 1 })],
    ["a negative daily loss limit", posture({ dailyMaxLossUsd: -1 })],
    ["a sub-cent daily loss limit", posture({ dailyMaxLossUsd: 10.001 })],
  ])("refuses %s and writes nothing", async (_label, body) => {
    const res = await PUT(makeRequest(body));
    expect(res.status).toBe(400);
    expect(setAccountRiskPosture).not.toHaveBeenCalled();
    expect(setAccountDailyPnlLimits).not.toHaveBeenCalled();
  });

  // The phase says what the account *is*, and three of its four refusals are
  // rules the operator cannot retry past. Each is asserted on the sentence as
  // well as the status: the route is the only surface that states the rule,
  // and nothing else fails when the wording drifts from the constant.
  describe("the account phase", () => {
    const combine = (extra: Record<string, unknown> = {}) =>
      posture({
        riskPhase: "combine",
        mllUsd: COMBINE_MLL_USD,
        startBalanceUsd: 50_000,
        ...extra,
      });

    it("writes the phase the body names", async () => {
      const res = await PUT(makeRequest(combine()));
      expect(res.status).toBe(200);
      expect(setAccountRiskPhase).toHaveBeenCalledWith(ACCOUNT_ID, {
        phase: "combine",
        mllUsd: COMBINE_MLL_USD,
        startBalanceUsd: 50_000,
        pressAtUsd: null,
      });
    });

    it("leaves the stored phase alone when the body does not name one", async () => {
      await PUT(makeRequest(posture()));
      expect(setAccountRiskPhase).not.toHaveBeenCalled();
    });

    it("clears the phase when the posture is cleared", async () => {
      await PUT(makeRequest({ accountId: ACCOUNT_ID }));
      expect(setAccountRiskPhase).toHaveBeenCalledWith(ACCOUNT_ID, null);
    });

    it.each(["off", "combine"] as const)(
      "refuses the post-payout phase on a %s row, and names the path",
      async (phase) => {
        vi.mocked(getAccountRiskPhase).mockReturnValue({ ...STORED_PHASE, phase });
        const res = await PUT(makeRequest(posture({ riskPhase: "funded_paid" })));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: PAYOUT_PHASE_PATH_REFUSAL });
        expect(setAccountRiskPhase).not.toHaveBeenCalled();
        expect(setAccountRiskPosture).not.toHaveBeenCalled();
      },
    );

    it("accepts the post-payout phase on a row that is funded before its payout", async () => {
      vi.mocked(getAccountRiskPhase).mockReturnValue({ ...STORED_PHASE, phase: "funded_fresh" });
      const res = await PUT(makeRequest(posture({ riskPhase: "funded_paid" })));
      expect(res.status).toBe(200);
      expect(setAccountRiskPhase).toHaveBeenCalledWith(ACCOUNT_ID, {
        phase: "funded_paid",
        mllUsd: null,
        startBalanceUsd: null,
        pressAtUsd: null,
      });
    });

    it.each(["combine", "funded_fresh"] as const)(
      "refuses %s once the account has taken a payout",
      async (riskPhase) => {
        // The one genuinely permanent refusal here: a funded account id is
        // never a combine again, and never goes back to pre-payout sizing.
        vi.mocked(getAccountRiskPhase).mockReturnValue({
          ...STORED_PHASE,
          phase: "funded_paid",
          payoutTakenAt: "2026-09-01T12:00:00.000Z",
        });
        const res = await PUT(makeRequest(combine({ riskPhase })));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: POST_PAYOUT_PHASE_REFUSAL });
        expect(setAccountRiskPhase).not.toHaveBeenCalled();
      },
    );

    it("leaves Off available after a payout", async () => {
      vi.mocked(getAccountRiskPhase).mockReturnValue({
        ...STORED_PHASE,
        phase: "funded_paid",
        payoutTakenAt: "2026-09-01T12:00:00.000Z",
      });
      const res = await PUT(makeRequest(posture({ riskPhase: "off" })));
      expect(res.status).toBe(200);
      expect(setAccountRiskPhase).toHaveBeenCalledWith(ACCOUNT_ID, {
        phase: "off",
        mllUsd: null,
        startBalanceUsd: null,
        pressAtUsd: null,
      });
    });

    it("refuses any phase on a non-Topstep account", async () => {
      // The row's broker tag, never its name — the live-account block is the
      // only predicate that reads a name.
      vi.mocked(getAccountRiskPhase).mockReturnValue({ ...STORED_PHASE, broker: "tradovate" });
      const res = await PUT(makeRequest(combine()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: NON_TOPSTEP_PHASE_REFUSAL });
      expect(setAccountRiskPhase).not.toHaveBeenCalled();
    });

    it("still accepts Off on a non-Topstep account", async () => {
      vi.mocked(getAccountRiskPhase).mockReturnValue({ ...STORED_PHASE, broker: "tradovate" });
      expect((await PUT(makeRequest(posture({ riskPhase: "off" })))).status).toBe(200);
    });

    it.each([
      ["a loss limit the buckets were not measured on", 3_000],
      ["no loss limit at all", undefined],
    ])("refuses a combine with %s", async (_label, mllUsd) => {
      const res = await PUT(makeRequest(combine({ mllUsd })));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: COMBINE_MLL_REFUSAL });
      expect(COMBINE_MLL_REFUSAL).toContain(COMBINE_MLL_USD.toLocaleString());
      expect(setAccountRiskPhase).not.toHaveBeenCalled();
    });

    it("answers 404 when the catalogue has no row for the account", async () => {
      vi.mocked(getAccountRiskPhase).mockReturnValue(null);
      const res = await PUT(makeRequest(combine()));
      expect(res.status).toBe(404);
      expect(setAccountRiskPosture).not.toHaveBeenCalled();
    });

    it.each([
      ["an unknown phase", posture({ riskPhase: "funded" })],
      ["a combine with no starting balance", combine({ startBalanceUsd: undefined })],
      ["a combine starting at $0", combine({ startBalanceUsd: 0 })],
      ["a sub-cent starting balance", combine({ startBalanceUsd: 50_000.001 })],
      [
        "a funded phase with no loss limit",
        posture({ riskPhase: "funded_fresh", startBalanceUsd: 0 }),
      ],
    ])("refuses %s and writes nothing", async (_label, body) => {
      const res = await PUT(makeRequest(body));
      expect(res.status).toBe(400);
      expect(setAccountRiskPhase).not.toHaveBeenCalled();
      expect(setAccountRiskPosture).not.toHaveBeenCalled();
      expect(setAccountDailyPnlLimits).not.toHaveBeenCalled();
    });

    it("takes a funded account starting at $0", async () => {
      const res = await PUT(
        makeRequest(
          posture({ riskPhase: "funded_fresh", mllUsd: 2_000, startBalanceUsd: 0 }),
        ),
      );
      expect(res.status).toBe(200);
      expect(setAccountRiskPhase).toHaveBeenCalledWith(ACCOUNT_ID, {
        phase: "funded_fresh",
        mllUsd: 2_000,
        startBalanceUsd: 0,
        pressAtUsd: null,
      });
    });

    describe("combine_press", () => {
      const press = (extra: Record<string, unknown> = {}) =>
        combine({ riskPhase: "combine_press", pressAtUsd: 1_500, ...extra });

      it("combine_press stores the press threshold on a good body", async () => {
        const res = await PUT(makeRequest(press()));
        expect(res.status).toBe(200);
        expect(setAccountRiskPhase).toHaveBeenCalledWith(ACCOUNT_ID, {
          phase: "combine_press",
          mllUsd: COMBINE_MLL_USD,
          startBalanceUsd: 50_000,
          pressAtUsd: 1_500,
        });
      });

      it("combine_press is refused once the account has taken a payout", async () => {
        vi.mocked(getAccountRiskPhase).mockReturnValue({
          ...STORED_PHASE,
          phase: "funded_paid",
          payoutTakenAt: "2026-09-01T12:00:00.000Z",
        });
        const res = await PUT(makeRequest(press()));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: POST_PAYOUT_PHASE_REFUSAL });
        expect(setAccountRiskPhase).not.toHaveBeenCalled();
      });

      it("combine_press is refused on any loss limit but $2,000", async () => {
        const res = await PUT(makeRequest(press({ mllUsd: 3_000 })));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: COMBINE_MLL_REFUSAL });
      });

      it.each([
        ["no threshold", undefined],
        ["a null threshold", null],
        ["a zero threshold", 0],
        ["a negative threshold", -100],
        ["a sub-cent threshold", 1_500.001],
        ["a text threshold", "1500"],
      ])("combine_press refuses %s and writes nothing", async (_label, pressAtUsd) => {
        const res = await PUT(makeRequest(press({ pressAtUsd })));
        expect(res.status).toBe(400);
        expect(setAccountRiskPhase).not.toHaveBeenCalled();
        expect(setAccountRiskPosture).not.toHaveBeenCalled();
      });

      it("refuses the post-payout phase straight from combine_press, and names the path", async () => {
        vi.mocked(getAccountRiskPhase).mockReturnValue({ ...STORED_PHASE, phase: "combine_press" });
        const res = await PUT(makeRequest(posture({ riskPhase: "funded_paid" })));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: PAYOUT_PHASE_PATH_REFUSAL });
      });

      it.each([
        ["combine", combine({ pressAtUsd: 1_500 })],
        ["funded_fresh", posture({ riskPhase: "funded_fresh", mllUsd: 2_000, startBalanceUsd: 0, pressAtUsd: 1_500 })],
        ["off", posture({ riskPhase: "off", pressAtUsd: 1_500 })],
      ])("nulls the threshold when combine_press changes to %s", async (_label, body) => {
        vi.mocked(getAccountRiskPhase).mockReturnValue({
          ...STORED_PHASE,
          phase: "combine_press",
          mllUsd: COMBINE_MLL_USD,
          startBalanceUsd: 50_000,
          pressAtUsd: 1_500,
        });
        const res = await PUT(makeRequest(body));
        expect(res.status).toBe(200);
        expect(setAccountRiskPhase).toHaveBeenCalledWith(
          ACCOUNT_ID,
          expect.objectContaining({ pressAtUsd: null }),
        );
      });
    });
  });

  it("refuses a body that is not JSON", async () => {
    const req = new NextRequest("http://localhost/api/accounts/risk", {
      method: "PUT",
      headers: { "x-session-token": "tok-abc", "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    expect(setAccountRiskPosture).not.toHaveBeenCalled();
  });
});

/**
 * A38's residual: the Risk block recomputed the verdict from the row and could
 * not see a refusal that comes from the catalog. The route now reports the
 * server's verdict on every row it returns, through the real
 * `autoTradeVerdictsForAccountIds`; only its catalog query is stubbed.
 */
describe("GET /api/accounts/risk — each row carries the server's auto-trade verdict", () => {
  type CatalogRow = { account_id: number; broker: string; account_name: string | null; practice: number | null };

  const PRAC = { id: 1001, name: "PRAC-V2-100200-90012114", practice: true };
  /** Invented: no funded name has been observed (topstep.md), and a name
   *  matching none of the permitted prefixes is what classifies LIVE. */
  const FUNDED = { id: 1002, name: "FUNDED-100200-11111111", practice: false };
  /** A practice name the verdict read finds no catalog row for. */
  const UNSEEDED = { id: 1003, name: "PRAC-V2-100200-77777777", practice: true };

  const seeded = (a: typeof PRAC): CatalogRow => ({
    account_id: a.id,
    broker: "topstep",
    account_name: a.name,
    practice: a.practice ? 1 : 0,
  });

  function catalog(rows: CatalogRow[]) {
    vi.mocked(getDb).mockReturnValue({
      prepare: () => ({ all: () => rows }),
    } as unknown as ReturnType<typeof getDb>);
  }

  function getRequest(): NextRequest {
    return new NextRequest("http://localhost/api/accounts/risk", {
      headers: { "x-session-token": "tok-abc" },
    });
  }

  async function verdictsOf(res: Response): Promise<Record<number, AutoTradeVerdict>> {
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ accountId: number; autoTrade: AutoTradeVerdict }> };
    return Object.fromEntries(body.accounts.map((a) => [a.accountId, a.autoTrade]));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    vi.mocked(listAccountRiskPostures).mockReturnValue(
      [PRAC, FUNDED, UNSEEDED].map((a) => ({
        accountId: a.id,
        name: a.name,
        broker: "topstep",
        practice: a.practice,
        posture: null,
      })) as unknown as ReturnType<typeof listAccountRiskPostures>,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("getDb() called in test — DB not available");
    });
  });

  it("A38 — attaches the catalog's verdict to every row", async () => {
    catalog([seeded(PRAC), seeded(FUNDED)]);

    const v = await verdictsOf(GET(getRequest()));

    expect(v[PRAC.id]).toEqual({ permitted: true });
    expect(v[FUNDED.id]).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
  });

  it("A38 — refuses an account with no account_brokers row as unverified, though its name is a practice name", async () => {
    catalog([seeded(PRAC), seeded(FUNDED)]);

    const v = await verdictsOf(GET(getRequest()));

    expect(v[UNSEEDED.id]).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
  });

  it("refuses every row as unverified when the catalog read throws", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("database is locked");
    });

    const v = await verdictsOf(GET(getRequest()));

    for (const a of [PRAC, FUNDED, UNSEEDED]) {
      expect(v[a.id]).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
    }
    // A request-time read, said under this route's own tag — not a boot step.
    expect(vi.mocked(log.event)).toHaveBeenCalledWith("db_error", "api.accounts.risk", expect.stringContaining("database is locked"));
  });

  it("A38 — a save answers with the same verdicts, so the saved list does not read refused", async () => {
    catalog([seeded(PRAC), seeded(FUNDED)]);
    vi.mocked(getAccountDailyPnlLimits).mockReturnValue({ ...STORED });
    vi.mocked(setAccountRiskPosture).mockReturnValue(true);

    const v = await verdictsOf(await PUT(makeRequest(posture())));

    expect(v[PRAC.id]).toEqual({ permitted: true });
    expect(v[FUNDED.id]).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
  });

  it("A38 — a clear answers with the same verdicts", async () => {
    catalog([seeded(PRAC), seeded(FUNDED)]);
    vi.mocked(setAccountRiskPosture).mockReturnValue(true);

    const v = await verdictsOf(await PUT(makeRequest({ accountId: ACCOUNT_ID, maxRiskPerTradeUsd: null, maxContracts: null })));

    expect(setAccountRiskPosture).toHaveBeenCalledWith(ACCOUNT_ID, null);
    expect(v[PRAC.id]).toEqual({ permitted: true });
    expect(v[FUNDED.id]).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
    expect(v[UNSEEDED.id]).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
  });
});
