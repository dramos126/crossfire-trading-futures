/**
 * Topstep's website account read: the boundary guard against the real answer,
 * what each record means as a status, every way the read fails without
 * throwing, and the two rules that are source facts rather than behaviour —
 * nothing calls the host with anything but GET, and nothing here can mint a
 * session.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

import {
  TOPSTEP_USERAPI_URL,
  parseTopstepTradingAccount,
  readTopstepTradingAccounts,
  topstepAccountState,
  topstepStatusAnswer,
  type TopstepTradingAccountDeps,
} from "./trading-account";

/**
 * The five records of a real `GET userapi.topstepx.com/TradingAccount` answer
 * (temp/tradingaccount.json, probed 2026-10-14), trimmed to the fields the app
 * reads plus three it does not — the real record carries about seventy, and
 * the guard must ignore the rest. Two combines and a practice account the
 * website shows dead; one live combine and one live practice account.
 */
const REAL_ANSWER = [
  {
    accountId: 28449820, accountName: "50KTC-SKU-V2-DLL-100200-37685446", ineligible: false, status: 0,
    lockoutReason: null, lockoutExpiration: null, autoOcoBrackets: true, bracketAutoApply: null,
    bracketAmountToRisk: null, bracketAmountToMake: null, startingBalance: 50000, maximumLoss: 48000,
    highestBalance: 50000,
    startOfDayBalance: 48722.9, dailyLoss: 1000, personalDailyLossLimit: null,
    personalDailyProfitTarget: null, stage: 1, templateId: 67,
    realizedDayPnl: 1057.92, type: 1, nickname: null,
  },
  {
    accountId: 90043379, accountName: "PRAC-V2-100200-62251871", ineligible: false, status: 0,
    lockoutReason: null, lockoutExpiration: null, autoOcoBrackets: true, bracketAutoApply: null,
    bracketAmountToRisk: null, bracketAmountToMake: null, startingBalance: 150000, maximumLoss: 150000,
    highestBalance: 158909.5,
    startOfDayBalance: 157639.58, dailyLoss: 0, personalDailyLossLimit: null,
    personalDailyProfitTarget: null, stage: 4, templateId: 7,
    realizedDayPnl: 0, type: 1, nickname: null,
  },
  {
    accountId: 90052071, accountName: "50KTC-SKU-V2-DLL-100200-34750030", ineligible: true, status: 2,
    lockoutReason: null, lockoutExpiration: null, autoOcoBrackets: true, bracketAutoApply: true,
    bracketAmountToRisk: 300, bracketAmountToMake: 600, startingBalance: 50000, maximumLoss: 49969.94,
    highestBalance: 51969.94,
    startOfDayBalance: 50023.05, dailyLoss: 1000, personalDailyLossLimit: null,
    personalDailyProfitTarget: null, stage: 1, templateId: 67,
    realizedDayPnl: 0, type: 1, nickname: null,
  },
  {
    accountId: 27456331, accountName: "50KTC-SKU-V2-DLL-100200-81789669", ineligible: true, status: 6,
    lockoutReason: null, lockoutExpiration: null, autoOcoBrackets: false, bracketAutoApply: true,
    bracketAmountToRisk: 300, bracketAmountToMake: 600, startingBalance: 50000, maximumLoss: 48773.2,
    highestBalance: 50773.2,
    startOfDayBalance: 48749.5, dailyLoss: 1000, personalDailyLossLimit: null,
    personalDailyProfitTarget: null, stage: 1, templateId: 67,
    realizedDayPnl: 0, type: 1, nickname: null,
  },
  {
    accountId: 23463375, accountName: "PRAC-V2-100200-44203525", ineligible: true, status: 6,
    lockoutReason: null, lockoutExpiration: null, autoOcoBrackets: false, bracketAutoApply: null,
    bracketAmountToRisk: null, bracketAmountToMake: null, startingBalance: 150000, maximumLoss: 145500,
    highestBalance: 150000,
    startOfDayBalance: 145262.4, dailyLoss: 0, personalDailyLossLimit: null,
    personalDailyProfitTarget: null, stage: 4, templateId: 7,
    realizedDayPnl: 0, type: 1, nickname: null,
  },
];

const NOW = new Date("2026-10-14T21:00:00.000Z");
/** A cached token good for another hour, in the cache's unix seconds. */
const TOKEN = { token: "jwt-abc", expiresAt: Math.floor(NOW.getTime() / 1000) + 3600 };

function recorder(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  });
  return { calls, fetchStub };
}

function deps(over: Partial<TopstepTradingAccountDeps> = {}): TopstepTradingAccountDeps {
  return {
    cachedToken: () => TOKEN,
    fetch: vi.fn(async () => Response.json(REAL_ANSWER)),
    now: () => NOW,
    ...over,
  } satisfies TopstepTradingAccountDeps;
}

describe("parseTopstepTradingAccount", () => {
  it("accepts every record of the real answer", () => {
    expect(REAL_ANSWER.every((r) => parseTopstepTradingAccount(r) !== null)).toBe(true);
  });

  it("refuses a record whose status field was renamed, typed differently, or left out rather than null", () => {
    const base = REAL_ANSWER[0]!;
    const { ineligible: _renamed, ...withoutIneligible } = base;
    expect(parseTopstepTradingAccount({ ...withoutIneligible, isIneligible: false })).toBeNull();
    expect(parseTopstepTradingAccount({ ...base, ineligible: "false" })).toBeNull();
    expect(parseTopstepTradingAccount({ ...base, accountId: "28449820" })).toBeNull();
    expect(parseTopstepTradingAccount({ ...base, status: null })).toBeNull();
    const { lockoutReason: _absent, ...withoutLockout } = base;
    expect(parseTopstepTradingAccount(withoutLockout)).toBeNull();
    const { lockoutExpiration: _gone, ...withoutExpiry } = base;
    expect(parseTopstepTradingAccount(withoutExpiry)).toBeNull();
    expect(parseTopstepTradingAccount(null)).toBeNull();
    expect(parseTopstepTradingAccount([base])).toBeNull();
  });

  it("does not accept a status field inherited rather than owned", () => {
    expect(parseTopstepTradingAccount(Object.create(REAL_ANSWER[0]!))).toBeNull();
  });

  // A program the probe never saw (XFA, a combine without a DLL) may carry a
  // null limit; that must not fail the answer and push every account onto the
  // search's coarser reading.
  it("reads a fact field that is null, absent or mistyped as unknown, not as a bad record", () => {
    const { autoOcoBrackets: _absent, ...withoutOco } = REAL_ANSWER[0]!;
    const parsed = parseTopstepTradingAccount({
      ...withoutOco,
      dailyLoss: null,
      maximumLoss: null,
      stage: "1",
    });
    expect(parsed).toMatchObject({
      accountId: 28449820,
      ineligible: false,
      status: 0,
      autoOcoBrackets: null,
      dailyLoss: null,
      maximumLoss: null,
      stage: null,
      startingBalance: 50000,
      templateId: 67,
    });
  });
});

describe("readTopstepTradingAccounts", () => {
  it("GETs the website's TradingAccount with the cached session token, and answers its records", async () => {
    const { calls, fetchStub } = recorder(() => Response.json(REAL_ANSWER));
    const answer = await readTopstepTradingAccounts(deps({ fetch: fetchStub }));
    expect(answer.ok && answer.at).toBe(NOW.toISOString());
    expect(answer.ok && answer.accounts.map((a) => a.accountId)).toEqual(REAL_ANSWER.map((r) => r.accountId));
    // The fields the app reads, and none of the ~seventy it does not.
    expect(answer.ok && answer.accounts[0]).toEqual({
      accountId: 28449820, accountName: "50KTC-SKU-V2-DLL-100200-37685446", ineligible: false, status: 0,
      lockoutReason: null, lockoutExpiration: null, autoOcoBrackets: true, bracketAutoApply: null,
      bracketAmountToRisk: null, bracketAmountToMake: null, startingBalance: 50000, maximumLoss: 48000,
      highestBalance: 50000, startOfDayBalance: 48722.9, dailyLoss: 1000, personalDailyLossLimit: null,
      personalDailyProfitTarget: null, stage: 1, templateId: 67,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TOPSTEP_USERAPI_URL}/TradingAccount`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc");
  });

  it("asks nothing when no token is cached, rather than logging in for one", async () => {
    const { fetchStub } = recorder(() => Response.json(REAL_ANSWER));
    const answer = await readTopstepTradingAccounts(deps({ cachedToken: () => null, fetch: fetchStub }));
    expect(answer).toEqual({ ok: false, kind: "no-token", reason: "no Topstep session token is cached" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("asks nothing on an expired token", async () => {
    const { fetchStub } = recorder(() => Response.json(REAL_ANSWER));
    const expired = { ...TOKEN, expiresAt: Math.floor(NOW.getTime() / 1000) - 1 };
    const answer = await readTopstepTradingAccounts(deps({ cachedToken: () => expired, fetch: fetchStub }));
    expect(answer.ok === false && answer.kind).toBe("expired");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  // A refused token is a failed read: retrying or recovering it would mean a
  // validate or a loginKey, and a mint displaces the engine's own hubs.
  it("answers a refused token as a failed read, once, with no retry", async () => {
    const { calls, fetchStub } = recorder(() => new Response("", { status: 401 }));
    const answer = await readTopstepTradingAccounts(deps({ fetch: fetchStub }));
    expect(answer).toEqual({ ok: false, kind: "unauthorized", reason: "HTTP 401" });
    expect(calls.map((c) => c.url)).toEqual([`${TOPSTEP_USERAPI_URL}/TradingAccount`]);
  });

  it("answers every other failure as a failed read of its kind rather than throwing", async () => {
    const cases: Array<[TopstepTradingAccountDeps["fetch"], string, string]> = [
      [async () => new Response("", { status: 503 }), "http", "HTTP 503"],
      [async () => { throw new TypeError("fetch failed"); }, "network", "fetch failed"],
      [async () => new Response("<html>", { status: 200 }), "shape", ""],
      [async () => Response.json({ accounts: REAL_ANSWER }), "shape", "the answer is not a list of accounts"],
      [
        async () => Response.json([REAL_ANSWER[0], { ...REAL_ANSWER[1], ineligible: null }]),
        "shape",
        "account record 2 of 2 has an unexpected shape",
      ],
    ];
    for (const [fetchImpl, kind, reason] of cases) {
      const answer = await readTopstepTradingAccounts(deps({ fetch: fetchImpl }));
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.kind).toBe(kind);
      if (!answer.ok && reason !== "") expect(answer.reason).toBe(reason);
    }
  });

  it("answers a record with a null fact field, as an unseen program may carry", async () => {
    const answer = await readTopstepTradingAccounts(
      deps({ fetch: async () => Response.json([REAL_ANSWER[0], { ...REAL_ANSWER[1], dailyLoss: null, maximumLoss: null }]) }),
    );
    expect(answer.ok).toBe(true);
    expect(answer.ok && answer.accounts[1]).toMatchObject({ accountId: 90043379, dailyLoss: null, maximumLoss: null });
  });

  it("answers an unreadable token cache as a failed read", async () => {
    const answer = await readTopstepTradingAccounts(
      deps({
        cachedToken: () => {
          throw new Error("database is locked");
        },
      }),
    );
    expect(answer).toEqual({ ok: false, kind: "no-token", reason: "token cache unreadable (database is locked)" });
  });
});

describe("topstepAccountState", () => {
  const AT = NOW.toISOString();
  const live = REAL_ANSWER[0]!;

  it("reads the real answer as the website shows it: three dead, two ok", () => {
    const answer = topstepStatusAnswer(REAL_ANSWER, AT);
    expect(answer.source).toBe("website");
    expect(answer.accounts.every((a) => a.source === "website")).toBe(true);
    expect(answer.accounts.map((a) => [a.accountId, a.state, a.statusCode])).toEqual([
      [28449820, "ok", 0],
      [90043379, "ok", 0],
      [90052071, "dead", 2],
      [27456331, "dead", 6],
      [23463375, "dead", 6],
    ]);
  });

  it("carries the OCO, auto-bracket and prefill fields through as reported", () => {
    expect(topstepAccountState(REAL_ANSWER[3]!, AT).facts).toEqual({
      autoOcoBrackets: false,
      bracketAutoApply: true,
      bracketAmountToRiskUsd: 300,
      bracketAmountToMakeUsd: 600,
      startingBalanceUsd: 50000,
      maximumLossUsd: 48773.2,
      highestBalanceUsd: 50773.2,
      startOfDayBalanceUsd: 48749.5,
      dailyLossUsd: 1000,
      personalDailyLossLimitUsd: null,
      personalDailyProfitTargetUsd: null,
      stage: 1,
      templateId: 67,
    });
  });

  it("reads a lockout ending later as locked, with its reason and end", () => {
    const state = topstepAccountState(
      { ...live, lockoutReason: "Daily loss limit", lockoutExpiration: "2026-10-15T22:00:00+00:00" },
      AT,
    );
    expect(state).toMatchObject({
      state: "locked",
      lockoutReason: "Daily loss limit",
      lockoutUntil: "2026-10-15T22:00:00.000Z",
    });
  });

  it("reads a lockout whose end has passed as ok", () => {
    const state = topstepAccountState({ ...live, lockoutExpiration: "2026-10-14T20:00:00+00:00" }, AT);
    expect(state.state).toBe("ok");
  });

  it("keeps a lockout with no readable end locked, because nothing says when it ends", () => {
    expect(topstepAccountState({ ...live, lockoutReason: "Manual" }, AT)).toMatchObject({
      state: "locked",
      lockoutUntil: null,
    });
    expect(topstepAccountState({ ...live, lockoutExpiration: "soon" }, AT).state).toBe("locked");
  });

  // Without a zone, `new Date` reads the string in the server's local time — a
  // guess at the end; the lock is kept with no end instead.
  it("reads a lockout end with no timezone as no end, and keeps it locked", () => {
    expect(
      topstepAccountState({ ...live, lockoutReason: "Daily loss limit", lockoutExpiration: "2026-10-14T20:00:00" }, AT),
    ).toMatchObject({ state: "locked", lockoutUntil: null });
  });

  it("carries a null fact field through as unknown", () => {
    expect(topstepAccountState({ ...live, dailyLoss: null, autoOcoBrackets: null }, AT).facts).toMatchObject({
      dailyLossUsd: null,
      autoOcoBrackets: null,
      startingBalanceUsd: 50000,
    });
  });

  it("reads an ineligible account as dead even while it is locked", () => {
    const state = topstepAccountState(
      { ...live, ineligible: true, status: 2, lockoutExpiration: "2026-10-15T22:00:00+00:00" },
      AT,
    );
    expect(state.state).toBe("dead");
  });
});

/**
 * Read-only by rule (docs/modules/brokers/topstep.md): nothing writes to the
 * website's host. Enumerated from source, per testing/patterns.md, because a
 * second caller could be added anywhere.
 */
describe("the website host is read-only", () => {
  const SRC = join(__dirname, "../../..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  /** A file's code with its comments stripped — a comment naming the host or
   *  what must not be done to it is not a call. */
  const codeOf = (file: string) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("is named in code by this file alone", () => {
    const naming = sourceFiles(SRC)
      .filter((f) => codeOf(f).includes("userapi.topstepx.com"))
      .map((f) => relative(SRC, f));
    expect(naming).toEqual([join("lib", "brokers", "topstep", "trading-account.ts")]);
  });

  const code = codeOf(join(__dirname, "trading-account.ts"));

  it("calls it with GET only", () => {
    const calls = code.match(/\bfetch\(/g) ?? [];
    const methods = [...code.matchAll(/method:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
    // The default dep forwards to the global; the read is the one real call.
    expect(calls.length).toBe(2);
    expect(methods).toEqual(["GET"]);
    expect(code).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/i);
  });

  it("has no path to a new session", () => {
    for (const minting of ["loginKey", "./auth", "./client", "getToken(", "validateOrRefreshToken", "authenticate("]) {
      expect(code).not.toContain(minting);
    }
    expect(code).toContain('from "./token-cache"');
  });
});
