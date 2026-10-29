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

vi.mock("@/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() },
}));

// The catalog seed is best-effort — the route swallows its throw into a
// `log.warn` — so the throwing `getDb` above is *not* what holds it under
// test. Without this mock every success-path assertion below passes with
// the seed silently failing, and deleting the seed outright stays green.
// Mock the write seam itself and assert the call.
vi.mock("@/lib/db/account-brokers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/account-brokers")>()),
  setAccountBrokers: vi.fn(),
}));

vi.mock("@/lib/settings/tradovate-defaults", () => ({
  resolveTradovateAppIdentity: vi.fn(),
}));

vi.mock("@/lib/brokers/topstep/client", () => ({
  TopstepClient: vi.fn(),
}));

// The route asks the plugin whether Topstep is configured and asks the
// plugin for the browser JWT. Cutting the chain at the registry keeps
// `require.context` out of the import graph (see testing/patterns.md).
const topstepPlugin = vi.hoisted(() => ({ isConfigured: vi.fn(() => true) }));

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { getPlugin: vi.fn(() => topstepPlugin) },
}));

vi.mock("@/lib/brokers/topstep/browser-token", () => ({
  topstepBrowserToken: vi.fn().mockResolvedValue("topstep-jwt"),
}));

vi.mock("@/lib/brokers/tradovate/client", () => ({
  TradovateClient: vi.fn(),
  readTradovateCredentialsFromDb: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getTradovateClientIfConfigured: vi.fn().mockResolvedValue(null),
  tradovateAuthError: vi.fn().mockReturnValue(null),
}));

import { GET } from "./route";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import {
  TradovateClient,
  readTradovateCredentialsFromDb,
} from "@/lib/brokers/tradovate/client";
import { setAccountBrokers } from "@/lib/db/account-brokers";
import { getDb } from "@/lib/db/connection";
import {
  LIVE_ACCOUNT_REFUSAL,
  STAGING_PRACTICE_ONLY_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
  type AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";
import {
  getTradovateClientIfConfigured,
  tradovateAuthError,
} from "@/lib/trading/engine/engine-singleton";

interface AccountsBody {
  accounts?: Array<{ id: number; name: string }>;
  error?: string;
  topstepError?: string | null;
  tradovateError?: string | null;
}

function makeRequest(token: string | null = "tok-abc"): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== null) headers["x-session-token"] = token;
  return new NextRequest("http://localhost/api/accounts", { headers });
}

// Both brokers stamp `broker` + `practice` at their own translator, so the
// fixtures carry them: they are two of the four fields the catalog seed
// writes, and a fixture missing them would let the seed assertion pass on
// a mapping that dropped them.
const TOPSTEP_ACCOUNTS = [
  { id: 1001, name: "PRAC-V2-100200-90012114", broker: "topstep", practice: true },
];
const TRADOVATE_ACCOUNTS = [
  { id: 2001, name: "DEMO-TRADOVATE", broker: "tradovate", practice: true, balance: 0 },
];

function stubTopstep(searchAccounts: ReturnType<typeof vi.fn>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(TopstepClient).mockImplementation(function (this: any) {
    this.setToken = vi.fn();
    this.searchAccounts = searchAccounts;
  });
}

/**
 * The route takes its Tradovate client from the engine singleton, so the
 * stub feeds `getTradovateClientIfConfigured` rather than the constructor.
 *
 * - `clientError` — the singleton itself threw.
 * - `noClient` — the singleton resolved null, i.e. the first
 *   authentication failed. Creds are present either way; the route only
 *   attempts this arm when they are.
 */
function stubTradovate(opts: {
  clientError?: Error;
  noClient?: boolean;
  searchAccounts?: ReturnType<typeof vi.fn>;
  getCashBalances?: ReturnType<typeof vi.fn>;
}) {
  vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { username: "u" } as any,
  );
  if (opts.clientError) {
    vi.mocked(getTradovateClientIfConfigured).mockRejectedValue(opts.clientError);
    return;
  }
  if (opts.noClient) {
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);
    return;
  }
  vi.mocked(getTradovateClientIfConfigured).mockResolvedValue({
    searchAccounts:
      opts.searchAccounts ??
      vi.fn().mockResolvedValue(TRADOVATE_ACCOUNTS.map((a) => ({ ...a }))),
    getCashBalances: opts.getCashBalances ?? vi.fn().mockResolvedValue(new Map()),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe("GET /api/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTopstep(vi.fn().mockResolvedValue(TOPSTEP_ACCOUNTS));
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    vi.mocked(tradovateAuthError).mockReturnValue(null);
    topstepPlugin.isConfigured.mockReturnValue(true);
    vi.mocked(topstepBrowserToken).mockResolvedValue("topstep-jwt");
  });

  it("returns 401 when x-session-token header is missing", async () => {
    const res = await GET(makeRequest(null));
    expect(res.status).toBe(401);
  });

  it("returns both brokers' accounts when both succeed", async () => {
    stubTradovate({});

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([1001, 2001]);
    expect(body.topstepError).toBeNull();
    expect(body.tradovateError).toBeNull();
  });

  it("still returns the Tradovate accounts when the Topstep fan-out throws", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));
    stubTradovate({});

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([2001]);
    expect(body.topstepError).toBe("Topstep 401");
    expect(body.tradovateError).toBeNull();
  });

  it("fetches Tradovate even though the Topstep call fails first", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));
    const searchAccounts = vi.fn().mockResolvedValue(TRADOVATE_ACCOUNTS.map((a) => ({ ...a })));
    stubTradovate({ searchAccounts });

    await GET(makeRequest());

    expect(searchAccounts).toHaveBeenCalled();
  });

  it("still returns the Topstep accounts when the Tradovate fan-out throws", async () => {
    stubTradovate({ clientError: new Error("Tradovate auth failed") });

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([1001]);
    expect(body.tradovateError).toBe("Tradovate auth failed");
    expect(body.topstepError).toBeNull();
  });

  it("reports an unavailable Tradovate client as a soft error, not an empty catalog", async () => {
    // Creds are present, so a null client means the first authentication
    // failed. Returning [] here would fulfil the arm, and the 500 branch
    // counts rejections — a total outage would render as "no accounts".
    stubTradovate({ noClient: true });

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([1001]);
    expect(body.tradovateError).toBeTruthy();
  });

  it("reports why the authentication failed, not a generic failure", async () => {
    // `initialize()` swallows the auth error on the way to a null client,
    // so the reason has to come off the plugin. A captcha lockout tells
    // the operator to wait it out; "authentication failed" sends them
    // re-checking credentials that are fine.
    stubTradovate({ noClient: true });
    vi.mocked(tradovateAuthError).mockReturnValue(
      "Tradovate p-captcha lockout on /auth/accesstokenrequest — third-party access disabled for ~1h",
    );

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(body.tradovateError).toContain("p-captcha lockout");
  });

  it("returns 500 when Topstep fails and the Tradovate client is unavailable", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));
    stubTradovate({ noClient: true });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
  });

  it("takes the Tradovate client from the engine singleton and never constructs its own", async () => {
    // A fresh client carries a virgin PenaltyResponseHandler, so every
    // dashboard load authenticates with no memory of the rate-limit
    // pressure the previous ones produced.
    stubTradovate({});

    await GET(makeRequest());

    expect(getTradovateClientIfConfigured).toHaveBeenCalled();
    expect(TradovateClient).not.toHaveBeenCalled();
  });

  it("returns 500 when every attempted broker fails", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));
    stubTradovate({ clientError: new Error("Tradovate auth failed") });

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(500);
    expect(body.error).toBe("Topstep 401");
  });

  it("returns 500 when every broker fails with an empty error message", async () => {
    // Topstep's client does `new Error(res.errorMessage ?? …)`, and `??`
    // does not catch `""` — a failure counter keyed on message truthiness
    // undercounts this into a 200 with an empty account list.
    stubTopstep(vi.fn().mockRejectedValue(new Error("")));
    stubTradovate({ searchAccounts: vi.fn().mockRejectedValue(new Error("")) });

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(500);
    expect(body.accounts).toBeUndefined();
    expect(body.error).toBeTruthy();
    expect(body.topstepError).toBeTruthy();
    expect(body.tradovateError).toBeTruthy();
  });

  it("returns 500 when the only attempted broker fails with an empty error message", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("")));

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(500);
    expect(body.error).toBeTruthy();
  });

  it("still returns the Tradovate catalog when Topstep fails with an empty message", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("")));
    stubTradovate({});

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([2001]);
    expect(body.topstepError).toBeTruthy();
  });

  it("returns 500 on a Topstep failure when Tradovate is not configured", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(TradovateClient).not.toHaveBeenCalled();
  });

  it("does not attempt Topstep at all when Topstep is not configured", async () => {
    topstepPlugin.isConfigured.mockReturnValue(false);
    stubTradovate({});

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([2001]);
    expect(body.topstepError).toBeNull();
    expect(TopstepClient).not.toHaveBeenCalled();
  });

  it("does not 500 on an unconfigured Topstep when Tradovate answers", async () => {
    // `attempted` counts configured brokers, not the fixed pair. Counting
    // Topstep as attempted here would make one Tradovate success look like
    // a partial outage on a Tradovate-only install.
    topstepPlugin.isConfigured.mockReturnValue(false);
    stubTradovate({});

    expect((await GET(makeRequest())).status).toBe(200);
  });

  it("503s when no broker is configured at all", async () => {
    topstepPlugin.isConfigured.mockReturnValue(false);
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    expect(((await res.json()) as AccountsBody).error).toBeTruthy();
  });

  it("reports a Topstep JWT it cannot mint as a soft per-broker error", async () => {
    vi.mocked(topstepBrowserToken).mockRejectedValue(new Error("Topstep gateway down"));
    stubTradovate({});

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([2001]);
    expect(body.topstepError).toBe("Topstep gateway down");
  });

  it("stamps Tradovate cash balances onto the accounts", async () => {
    stubTradovate({ getCashBalances: vi.fn().mockResolvedValue(new Map([[2001, 51234.5]])) });

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(body.accounts?.find((a) => a.id === 2001)).toMatchObject({ balance: 51234.5 });
  });

  it("keeps the Tradovate accounts when only the balance fetch fails", async () => {
    stubTradovate({ getCashBalances: vi.fn().mockRejectedValue(new Error("balance 503")) });

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([1001, 2001]);
    expect(body.tradovateError).toBeNull();
  });
});

// This route is the live-account block's only recovery path: an account
// added after the last boot has no `account_brokers` row, `autoTradeVerdict`
// refuses it as unclassifiable, and the refusal tells the operator to reload
// the dashboard — which reaches this seed and no other writer of that table.
describe("GET /api/accounts — account_brokers seeding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTopstep(vi.fn().mockResolvedValue(TOPSTEP_ACCOUNTS));
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    vi.mocked(tradovateAuthError).mockReturnValue(null);
    topstepPlugin.isConfigured.mockReturnValue(true);
    vi.mocked(topstepBrowserToken).mockResolvedValue("topstep-jwt");
  });

  it("seeds the catalog with every field the classifier needs", async () => {
    stubTradovate({});

    await GET(makeRequest());

    expect(setAccountBrokers).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setAccountBrokers).mock.calls[0][0]).toEqual([
      {
        accountId: 1001,
        broker: "topstep",
        name: "PRAC-V2-100200-90012114",
        practice: true,
      },
      { accountId: 2001, broker: "tradovate", name: "DEMO-TRADOVATE", practice: true },
    ]);
  });

  it("seeds the surviving broker's accounts when the other arm fails", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));
    stubTradovate({});

    await GET(makeRequest());

    expect(vi.mocked(setAccountBrokers).mock.calls[0][0]).toEqual([
      { accountId: 2001, broker: "tradovate", name: "DEMO-TRADOVATE", practice: true },
    ]);
  });

  it("does not seed when every attempted broker failed", async () => {
    stubTopstep(vi.fn().mockRejectedValue(new Error("Topstep 401")));
    stubTradovate({ clientError: new Error("Tradovate auth failed") });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(setAccountBrokers).not.toHaveBeenCalled();
  });

  it("still renders the catalog when the seed write throws", async () => {
    vi.mocked(setAccountBrokers).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    stubTradovate({});

    const res = await GET(makeRequest());
    const body = (await res.json()) as AccountsBody;

    expect(res.status).toBe(200);
    expect(body.accounts?.map((a) => a.id)).toEqual([1001, 2001]);
  });
});

/**
 * A38: the client recomputed the verdict from the row and could not see the
 * one refusal that comes from the catalog — an `account_brokers` row the seed
 * failed to write. The route now reports the server's verdict on each row,
 * read after the seed through the real `autoTradeVerdictsForAccountIds` and
 * `autoTradeVerdict`; only the catalog read is stubbed, at `getDb`.
 */
describe("GET /api/accounts — each row carries the server's auto-trade verdict", () => {
  type CatalogRow = { account_id: number; broker: string; account_name: string | null; practice: number | null };

  function catalog(rows: CatalogRow[]) {
    vi.mocked(getDb).mockReturnValue({
      prepare: () => ({ all: () => rows }),
    } as unknown as ReturnType<typeof getDb>);
  }

  async function verdicts(): Promise<Record<number, AutoTradeVerdict>> {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ id: number; autoTrade: AutoTradeVerdict }> };
    return Object.fromEntries(body.accounts.map((a) => [a.id, a.autoTrade]));
  }

  const PRAC = { id: 1001, name: "PRAC-V2-100200-90012114", broker: "topstep", practice: true };
  /** Invented: no funded name has been observed (topstep.md), and a name
   *  matching none of the permitted prefixes is what classifies LIVE. */
  const FUNDED = { id: 1002, name: "FUNDED-100200-11111111", broker: "topstep", practice: false };
  const COMBINE = { id: 1003, name: "50KTC-V2-100200-90020038", broker: "topstep", practice: false };

  const seeded = (a: typeof PRAC): CatalogRow => ({
    account_id: a.id,
    broker: a.broker,
    account_name: a.name,
    practice: a.practice ? 1 : 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    stubTopstep(vi.fn().mockResolvedValue([PRAC, FUNDED, COMBINE]));
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    topstepPlugin.isConfigured.mockReturnValue(true);
    vi.mocked(topstepBrowserToken).mockResolvedValue("topstep-jwt");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("getDb() called in test — DB not available");
    });
  });

  it("A38 — refuses an unseeded row as unverified, though its name is a practice name", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    vi.mocked(setAccountBrokers).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    catalog([seeded(FUNDED), seeded(COMBINE)]);

    const v = await verdicts();

    expect(v[PRAC.id]).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
  });

  it("A38 — refuses a funded account with the live-account sentence, and permits a seeded practice account", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    catalog([seeded(PRAC), seeded(FUNDED), seeded(COMBINE)]);

    const v = await verdicts();

    expect(v[FUNDED.id]).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
    expect(v[PRAC.id]).toEqual({ permitted: true });
    expect(v[COMBINE.id]).toEqual({ permitted: true });
  });

  it("A38 — refuses a Combine on staging with the staging sentence", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    catalog([seeded(PRAC), seeded(FUNDED), seeded(COMBINE)]);

    const v = await verdicts();

    expect(v[COMBINE.id]).toEqual({ permitted: false, reason: STAGING_PRACTICE_ONLY_REFUSAL });
    // The TOS refusal is answered first, so a funded account is still told it is live.
    expect(v[FUNDED.id]).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
    expect(v[PRAC.id]).toEqual({ permitted: true });
  });

  it("refuses every row as unverified when the catalog read throws", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("database is locked");
    });

    const v = await verdicts();

    for (const a of [PRAC, FUNDED, COMBINE]) {
      expect(v[a.id]).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
    }
  });
});
