/**
 * The dead cached token (bugs.md A88): a token the gateway has killed while
 * the `auth_token` row still says it has most of a day left.
 *
 * Runs the real `auth.ts` + `TopstepClient` pair over an in-memory
 * `auth_token` table (the migration is replayed, per db/auth.test.ts) with
 * `fetch` as a small gateway. The in-flight mint, the recovery cooldown, the
 * failed-mint backoff and the registered hook live on `globalThis`, not in
 * the modules — so a fresh registry alone isolates nothing, and `load()`
 * drops that state as well.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { PlaceOrderRequest } from "@/lib/brokers/types";

let db: InstanceType<typeof Database>;
const { migrations, logStub, creds } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
  logStub: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() },
  creds: { userName: "operator", apiKey: "api-key" },
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

vi.mock("@/lib/db/settings-cache", () => ({
  resolveTopstepUsername: vi.fn(() => creds.userName),
  resolveTopstepApiKey: vi.fn(() => creds.apiKey),
}));

vi.mock("@/lib/logger", () => ({ log: logStub }));

const ACCOUNT_SEARCH = "/api/Account/search";
const VALIDATE = "/api/Auth/validate";
const LOGIN_KEY = "/api/Auth/loginKey";
const ORDER_PLACE = "/api/Order/place";

const DEAD = "tok-dead";
const NOW = new Date("2026-09-30T15:00:00Z");
const DAY_SEC = 24 * 60 * 60;
/** What the gateway says when it refuses a login — it echoes the user name. */
const LOGIN_REFUSAL = "login refused for operator: bad key";

const placeRequest: PlaceOrderRequest = {
  accountId: 1,
  contractId: "CON.F.US.MNQ.Z26",
  type: 2,
  side: 0,
  size: 1,
};

interface Gateway {
  /** Bearers the gateway accepts. */
  live: Set<string>;
  /** Tokens `/Auth/loginKey` hands out, in order. */
  mints: string[];
  /** Whether a minted token is accepted afterwards. */
  mintsAreLive: boolean;
  loginSucceeds: boolean;
  /** Non-null: `/Auth/loginKey` answers this HTTP status with `LOGIN_REFUSAL` as its body. */
  loginStatus: number | null;
  /** Held open by a test that needs the mint airborne. */
  loginGate: Promise<void>;
  calls: Array<{ path: string; bearer: string | null }>;
  count(path: string): number;
}

function stubGateway(): Gateway {
  const gw: Gateway = {
    live: new Set(),
    mints: ["tok-fresh", "tok-fresh-2", "tok-fresh-3"],
    mintsAreLive: true,
    loginSucceeds: true,
    loginStatus: null,
    loginGate: Promise.resolve(),
    calls: [],
    count: (path) => gw.calls.filter((c) => c.path === path).length,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      const path = new URL(url).pathname;
      const bearer = init.headers.Authorization?.replace("Bearer ", "") ?? null;
      gw.calls.push({ path, bearer });
      const ok = (body: object) => ({ ok: true, status: 200, json: async () => body });
      if (path === LOGIN_KEY) {
        await gw.loginGate;
        if (gw.loginStatus !== null) {
          return { ok: false, status: gw.loginStatus, text: async () => LOGIN_REFUSAL };
        }
        if (!gw.loginSucceeds) return ok({ success: false, errorMessage: LOGIN_REFUSAL });
        const token = gw.mints.shift() ?? "tok-exhausted";
        if (gw.mintsAreLive) gw.live.add(token);
        return ok({ success: true, token });
      }
      if (bearer === null || !gw.live.has(bearer)) {
        return { ok: false, status: 401, text: async () => "" };
      }
      return ok({ success: true, accounts: [], newToken: bearer, orderId: 7 });
    }),
  );
  return gw;
}

/**
 * `secondGraph` re-imports the pair the way a second module-loader context
 * does — the instrumentation hook's graph beside the route handlers' — over
 * the same process state and the same `auth_token` row.
 */
async function load(opts: { secondGraph?: boolean } = {}) {
  if (opts.secondGraph) vi.resetModules();
  // Every import re-registers the migration; replay only this registry's.
  migrations.length = 0;
  const { TopstepClient, UnauthorizedError, TOPSTEP_SESSION_STATE_KEY } = await import("./client");
  if (!opts.secondGraph) delete (globalThis as Record<string, unknown>)[TOPSTEP_SESSION_STATE_KEY];
  const auth = await import("./auth");
  const cache = await import("@/lib/db/auth");
  if (!opts.secondGraph) {
    db = new Database(":memory:");
    for (const fn of migrations) fn(db);
  }
  /** What every route and the engine do: token from `getToken()`, onto a client. */
  const client = async () => {
    const c = new TopstepClient();
    c.setToken(await auth.getToken());
    return c;
  };
  const seedDeadToken = () => cache.setCachedToken(DEAD, Math.floor(NOW.getTime() / 1000) + DAY_SEC);
  return { auth, cache, client, seedDeadToken, UnauthorizedError };
}

function events(name: string): unknown[][] {
  return logStub.event.mock.calls.filter((c) => c[0] === name);
}

function debugLines(pattern: RegExp): string[] {
  return logStub.debug.mock.calls.map((c) => c.join(" ")).filter((line) => pattern.test(line));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of Object.values(logStub)) fn.mockClear();
  creds.userName = "operator";
  creds.apiKey = "api-key";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dead cached token recovery", () => {
  it("serves the dead token from the hot path with no network call (the defect's first half)", async () => {
    const gw = stubGateway();
    const { auth, seedDeadToken } = await load();
    seedDeadToken();

    await expect(auth.getToken()).resolves.toBe(DEAD);
    expect(gw.calls).toEqual([]);
  });

  it("clears the cache, cold-mints once and retries when the 401 survives validate", async () => {
    const gw = stubGateway();
    const { auth, cache, client, seedDeadToken } = await load();
    seedDeadToken();

    const c = await client();
    await expect(c.searchAccounts()).resolves.toEqual([]);

    expect(gw.calls.map((x) => x.path)).toEqual([ACCOUNT_SEARCH, VALIDATE, LOGIN_KEY, ACCOUNT_SEARCH]);
    expect(c.getToken()).toBe("tok-fresh");
    expect(cache.getCachedToken()?.token).toBe("tok-fresh");
    // The next caller — the /api/accounts fan-out, the banner's Reconnect —
    // gets the live token from the hot path instead of the dead one.
    await expect(auth.getToken()).resolves.toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });

  it("funnels concurrent 401s through one mint", async () => {
    const gw = stubGateway();
    let release = () => {};
    gw.loginGate = new Promise((r) => {
      release = r;
    });
    const { client, seedDeadToken } = await load();
    seedDeadToken();

    const clients = [await client(), await client(), await client()];
    const settled = Promise.all(clients.map((c) => c.searchAccounts()));
    // Every caller is past its own failed validate and parked on the mint.
    await vi.waitFor(() => expect(gw.count(VALIDATE)).toBe(3));
    release();

    await expect(settled).resolves.toEqual([[], [], []]);
    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(events("broker_token_dead")).toHaveLength(1);
  });

  it("gives a caller still holding the dead token the replacement without minting again", async () => {
    const gw = stubGateway();
    const { client, seedDeadToken } = await load();
    seedDeadToken();

    const late = await client();
    await (await client()).searchAccounts();
    expect(late.getToken()).toBe(DEAD);

    await expect(late.searchAccounts()).resolves.toEqual([]);
    expect(late.getToken()).toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });

  it("does not mint again when the freshly minted token is refused too", async () => {
    const gw = stubGateway();
    gw.mintsAreLive = false;
    const { cache, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();

    await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(gw.count(LOGIN_KEY)).toBe(1);

    // Each later caller picks the minted token up from the hot path and is
    // refused on it. None of them may clear it and mint: that is one new
    // Topstep session per request for as long as the credentials are bad.
    for (let i = 0; i < 3; i++) {
      await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(cache.getCachedToken()?.token).toBe("tok-fresh");
    expect(events("broker_token_dead")).toHaveLength(1);
  });

  it("allows one more recovery once the cooldown has run", async () => {
    const gw = stubGateway();
    gw.mintsAreLive = false;
    const { auth, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();
    await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);

    vi.setSystemTime(NOW.getTime() + auth.DEAD_TOKEN_RECOVERY_COOLDOWN_MS - 1);
    await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(gw.count(LOGIN_KEY)).toBe(1);

    vi.setSystemTime(NOW.getTime() + auth.DEAD_TOKEN_RECOVERY_COOLDOWN_MS);
    gw.mintsAreLive = true;
    await expect((await client()).searchAccounts()).resolves.toEqual([]);
    expect(gw.count(LOGIN_KEY)).toBe(2);
  });

  it("drops the dead token on an /api/Order/place 401 without retrying or minting", async () => {
    const gw = stubGateway();
    const { auth, cache, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();

    await expect((await client()).placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);

    expect(gw.calls).toEqual([{ path: ORDER_PLACE, bearer: DEAD }]);
    expect(cache.getCachedToken()).toBeNull();
    expect(events("broker_token_dead")).toHaveLength(1);

    // The next call recovers through the ordinary cold path.
    await expect(auth.getToken()).resolves.toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(gw.count(ORDER_PLACE)).toBe(1);
  });

  it("does not drop a freshly minted token on a second place 401 inside the cooldown", async () => {
    const gw = stubGateway();
    gw.mintsAreLive = false;
    const { cache, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();

    await expect((await client()).placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect((await client()).placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect((await client()).placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);

    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(cache.getCachedToken()?.token).toBe("tok-fresh");
  });

  it("rethrows the original 401 and says so once when the mint fails", async () => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    const { client, seedDeadToken } = await load();
    seedDeadToken();

    await expect((await client()).searchAccounts()).rejects.toThrow(
      `Unauthorized on ${ACCOUNT_SEARCH}`,
    );

    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(events("broker_token_dead")).toHaveLength(1);
    expect(events("broker_token_recovery_failed")).toHaveLength(1);
  });

  function allLogLines(): string[] {
    return Object.values(logStub).flatMap((fn) => fn.mock.calls.map((c) => c.join(" ")));
  }

  it("never writes a token into a log line", async () => {
    stubGateway();
    const { client, seedDeadToken } = await load();
    seedDeadToken();
    await (await client()).searchAccounts();

    // Counted on the event, so a stray debug line cannot stand in for it.
    expect(events("broker_token_dead")).toHaveLength(1);
    for (const line of allLogLines()) {
      expect(line).not.toContain(DEAD);
      expect(line).not.toContain("tok-fresh");
    }
  });

  it.each([
    { name: "a refused login", loginStatus: null, says: "Error" },
    { name: "an HTTP failure", loginStatus: 503, says: "HTTP 503" },
  ])("reports a failed recovery mint by kind, never by the gateway's words — $name", async ({ loginStatus, says }) => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    gw.loginStatus = loginStatus;
    const { client, seedDeadToken } = await load();
    seedDeadToken();
    await expect((await client()).searchAccounts()).rejects.toThrow();

    const failed = events("broker_token_recovery_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].join(" ")).toContain(says);
    for (const line of allLogLines()) {
      expect(line).not.toContain(DEAD);
      expect(line).not.toContain(LOGIN_REFUSAL);
      expect(line).not.toContain(creds.userName);
      expect(line).not.toContain(creds.apiKey);
    }
  });

  it("says once, at debug, that the cooldown suppressed a recovery", async () => {
    const gw = stubGateway();
    gw.mintsAreLive = false;
    const { client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();
    await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(debugLines(/cooldown/)).toHaveLength(0);

    await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(debugLines(/cooldown/)).toHaveLength(1);
  });

  it("recovers a client still holding the dead token after its own place 401 dropped the row", async () => {
    const gw = stubGateway();
    const { cache, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();

    // The engine's client: one instance, and nothing re-stamps it between ticks.
    const engine = await client();
    await expect(engine.placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(cache.getCachedToken()).toBeNull();

    await expect(engine.searchAccounts()).resolves.toEqual([]);
    expect(engine.getToken()).toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(gw.count(ORDER_PLACE)).toBe(1);
  });

  it("starts one mint, not one per call, for a client left on the dead token after a place 401", async () => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    const { auth, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();

    const engine = await client();
    await expect(engine.placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(NOW.getTime() + (i + 1) * auth.FAILED_MINT_BACKOFF_MS);
      await expect(engine.searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    }
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });

  it("keeps the row when a place 401 arrives on a stale client and the cache holds a different, live token", async () => {
    const gw = stubGateway();
    const { cache, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();
    const stale = await client();
    gw.live.add("tok-live");
    cache.setCachedToken("tok-live", Math.floor(NOW.getTime() / 1000) + DAY_SEC);

    await expect(stale.placeOrder(placeRequest)).rejects.toBeInstanceOf(UnauthorizedError);

    expect(cache.getCachedToken()?.token).toBe("tok-live");
    expect(events("broker_token_dead")).toHaveLength(0);
    expect(gw.count(LOGIN_KEY)).toBe(0);
  });

  it("fails every rider when the one mint they share fails", async () => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    let release = () => {};
    gw.loginGate = new Promise((r) => {
      release = r;
    });
    const { cache, client, seedDeadToken } = await load();
    seedDeadToken();

    const clients = [await client(), await client(), await client()];
    const settled = Promise.allSettled(clients.map((c) => c.searchAccounts()));
    await vi.waitFor(() => expect(gw.count(VALIDATE)).toBe(3));
    release();

    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const r of results) {
      expect(String((r as PromiseRejectedResult).reason)).toContain(`Unauthorized on ${ACCOUNT_SEARCH}`);
    }
    expect(gw.count(LOGIN_KEY)).toBe(1);
    expect(events("broker_token_recovery_failed")).toHaveLength(1);
    expect(cache.getCachedToken()).toBeNull();
  });
});

describe("a standby engine process holds the shared token", () => {
  // The running engine's session is the one `auth_token` row: a mint kicks
  // its hubs, and a drop sends its next call to a mint.
  it("serves a live cached token from the hot path with no network call", async () => {
    const gw = stubGateway();
    const { auth, seedDeadToken } = await load();
    seedDeadToken();
    auth.holdTokenRefresh(true);

    await expect(auth.getToken()).resolves.toBe(DEAD);
    expect(gw.calls).toEqual([]);
  });

  it("serves a token inside its refresh window as it is, without validating it", async () => {
    const gw = stubGateway();
    const { auth, cache } = await load();
    cache.setCachedToken("tok-near-expiry", Math.floor(NOW.getTime() / 1000) + 60);
    auth.holdTokenRefresh(true);

    await expect(auth.getToken()).resolves.toBe("tok-near-expiry");
    expect(gw.calls).toEqual([]);
  });

  it("mints nothing on an empty cache, and says why", async () => {
    const gw = stubGateway();
    const { auth } = await load();
    auth.holdTokenRefresh(true);

    await expect(auth.getToken()).rejects.toThrow("standby engine");
    await expect(auth.validateOrRefreshToken()).rejects.toThrow("standby engine");
    expect(gw.count(LOGIN_KEY)).toBe(0);
  });

  it("neither validates, mints nor drops the row on a 401", async () => {
    const gw = stubGateway();
    const { auth, cache, client, seedDeadToken, UnauthorizedError } = await load();
    seedDeadToken();
    auth.holdTokenRefresh(true);

    await expect((await client()).searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(gw.calls.map((x) => x.path)).toEqual([ACCOUNT_SEARCH]);
    expect(cache.getCachedToken()?.token).toBe(DEAD);
  });

  it("refreshes as before once released, at takeover", async () => {
    const gw = stubGateway();
    const { auth } = await load();
    auth.holdTokenRefresh(true);
    auth.holdTokenRefresh(false);

    await expect(auth.getToken()).resolves.toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });
});

describe("failed-mint backoff", () => {
  it("does not hold back the first mint of a process", async () => {
    const gw = stubGateway();
    const { auth } = await load();

    await expect(auth.getToken()).resolves.toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });

  it("rethrows the last failure with no network call inside the backoff, and mints again after it", async () => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    const { auth } = await load();

    await expect(auth.getToken()).rejects.toThrow(LOGIN_REFUSAL);
    expect(gw.calls).toHaveLength(1);

    // What a dashboard poll does while the gateway refuses every login.
    vi.setSystemTime(NOW.getTime() + auth.FAILED_MINT_BACKOFF_MS - 1);
    for (let i = 0; i < 5; i++) {
      await expect(auth.getToken()).rejects.toThrow(LOGIN_REFUSAL);
    }
    expect(gw.calls).toHaveLength(1);

    vi.setSystemTime(NOW.getTime() + auth.FAILED_MINT_BACKOFF_MS);
    gw.loginSucceeds = true;
    await expect(auth.getToken()).resolves.toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(2);
  });

  it("does not let rethrown failures push the backoff out", async () => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    const { auth } = await load();
    await expect(auth.getToken()).rejects.toThrow();

    vi.setSystemTime(NOW.getTime() + auth.FAILED_MINT_BACKOFF_MS - 1);
    await expect(auth.getToken()).rejects.toThrow();
    vi.setSystemTime(NOW.getTime() + auth.FAILED_MINT_BACKOFF_MS);
    await expect(auth.getToken()).rejects.toThrow();

    expect(gw.count(LOGIN_KEY)).toBe(2);
  });

  it("mints at once when the credentials have been re-saved", async () => {
    const gw = stubGateway();
    gw.loginSucceeds = false;
    const { auth } = await load();
    await expect(auth.getToken()).rejects.toThrow(LOGIN_REFUSAL);

    // Settings wrote a new key: the failure belonged to the old one.
    creds.apiKey = "api-key-2";
    gw.loginSucceeds = true;
    await expect(auth.getToken()).resolves.toBe("tok-fresh");
    expect(gw.count(LOGIN_KEY)).toBe(2);
  });
});

describe("process state shared across module graphs", () => {
  it("funnels two graphs' callers through one mint", async () => {
    const gw = stubGateway();
    let release = () => {};
    gw.loginGate = new Promise((r) => {
      release = r;
    });
    const first = await load();
    const airborne = first.auth.getToken();
    await vi.waitFor(() => expect(gw.count(LOGIN_KEY)).toBe(1));

    const second = await load({ secondGraph: true });
    const rider = second.auth.getToken();
    release();

    await expect(Promise.all([airborne, rider])).resolves.toEqual(["tok-fresh", "tok-fresh"]);
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });

  it("holds the second graph to the cooldown the first one stamped", async () => {
    const gw = stubGateway();
    gw.mintsAreLive = false;
    const first = await load();
    first.seedDeadToken();
    await expect((await first.client()).searchAccounts()).rejects.toBeInstanceOf(first.UnauthorizedError);
    expect(gw.count(LOGIN_KEY)).toBe(1);

    const second = await load({ secondGraph: true });
    await expect((await second.client()).searchAccounts()).rejects.toBeInstanceOf(second.UnauthorizedError);
    expect(gw.count(LOGIN_KEY)).toBe(1);
  });
});
