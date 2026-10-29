/**
 * `POST /api/auth` — sign-in and resume. Real in-memory SQLite behind the
 * real session store and account (auth.test.ts's pattern), so "no session"
 * is asserted as no `app_session` row and no cookie, not as a mock not called.
 * Brokers and the engine handle are stubbed; they are not under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

vi.mock("@/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() },
}));

// The real check, spied, so a test can count how many ran and park one.
vi.mock("@/lib/db/web-account", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/web-account")>();
  return { ...real, verifyWebAccount: vi.fn(real.verifyWebAccount) };
});

vi.mock("@/lib/brokers/topstep/auth", () => ({ getToken: vi.fn() }));

const hubs = vi.hoisted(() => ({ ready: null as boolean | null }));
vi.mock("@/lib/trading/engine/handle/local", () => ({
  localEngineHandle: () => ({ areHubsReady: async () => hubs.ready }),
}));

// Cut the chain at the registry so `require.context` stays out of the
// import graph (see testing/patterns.md).
const plugins = vi.hoisted(() => ({
  topstep: { isConfigured: vi.fn(() => false) },
  tradovate: {
    isConfigured: vi.fn(() => true),
    initialize: vi.fn(async () => {}),
    getClient: vi.fn((): unknown => null),
    hasLiveToken: vi.fn(() => true),
  },
}));

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    getPlugin: vi.fn((id: string) => (id === "topstep" ? plugins.topstep : plugins.tradovate)),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "./route";
import { POST as LOGOUT } from "./logout/route";
import { POST as CHANGE_PASSWORD } from "./password/route";
import { createWebAccount, verifyWebAccount } from "@/lib/db/web-account";
import { createSession, validateSession } from "@/lib/db/auth";
import {
  limitedAttempt,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_GLOBAL_FAILURE_LIMIT,
  resetLoginLimiterForTests,
} from "@/lib/auth/login-limiter";
import { INVALID_SIGN_IN_MESSAGE } from "@/lib/auth/sign-in-wire";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { log } from "@/lib/logger";

/** Fills the global ceiling the cheap way — no scrypt — from forged addresses. */
async function floodFromForgedAddresses(): Promise<void> {
  for (let i = 0; i < LOGIN_GLOBAL_FAILURE_LIMIT; i++) {
    await limitedAttempt(`forged-${i}`, async () => false, (ok) => ok);
  }
}

const NAME = "operator";
const PASSWORD = "correct horse battery";
const ADDRESS = "198.51.100.7";

function authRequest(
  body?: unknown,
  { cookie, address = ADDRESS, proto }: { cookie?: string; address?: string; proto?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": address };
  if (cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (proto !== undefined) headers["x-forwarded-proto"] = proto;
  return new NextRequest("http://localhost/api/auth", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function signIn(username = NAME, password = PASSWORD, opts: { address?: string; proto?: string } = {}) {
  return POST(authRequest({ username, password }, opts));
}

function sessionRows(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM app_session`).get() as { n: number }).n;
}

function cookieToken(res: Response): string {
  const match = /crossfire_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("no session cookie set");
  return match[1];
}

beforeEach(async () => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  resetLoginLimiterForTests();
  vi.clearAllMocks();
  hubs.ready = null;
  plugins.topstep.isConfigured.mockReturnValue(false);
  plugins.tradovate.isConfigured.mockReturnValue(true);
  plugins.tradovate.initialize.mockResolvedValue(undefined);
  plugins.tradovate.hasLiveToken.mockReturnValue(true);
  await createWebAccount(NAME, PASSWORD);
});

describe("POST /api/auth — sign in", () => {
  it("mints a session into an HttpOnly cookie, never into the body, when the pair verifies and a broker authenticates", async () => {
    hubs.ready = true;
    const res = await signIn();
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ signedIn: true, engineReady: true });
    expect(validateSession(cookieToken(res))).toBe(true);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
    expect(sessionRows()).toBe(1);
  });

  it("no session without a verifying pair — one 401 body whichever half was wrong", async () => {
    const wrongName = await signIn("someone-else", PASSWORD);
    const wrongPassword = await signIn(NAME, "not the password at all");
    for (const res of [wrongName, wrongPassword]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const bodies = [await wrongName.text(), await wrongPassword.text()];
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0])).toEqual({ invalidSignIn: true, error: INVALID_SIGN_IN_MESSAGE });
    expect(sessionRows()).toBe(0);
  });

  it("no session without a configured broker — the pair alone is not enough", async () => {
    plugins.tradovate.isConfigured.mockReturnValue(false);
    const res = await signIn();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ needsSetup: true });
    expect(sessionRows()).toBe(0);
  });

  it("no session when the configured broker refuses — today's broker check, after the pair", async () => {
    plugins.tradovate.getClient.mockReturnValue({});
    plugins.tradovate.hasLiveToken.mockReturnValue(false);
    const res = await signIn();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/Tradovate authentication failed/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(sessionRows()).toBe(0);
  });

  it("answers needsAccount on an install with a broker and no sign-in account", async () => {
    db.prepare(`DELETE FROM web_account`).run();
    const res = await signIn();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ needsAccount: true });
  });

  it("marks the cookie Secure only when the request came over https", async () => {
    expect((await signIn()).headers.get("set-cookie")).not.toMatch(/Secure/);
    expect((await signIn(NAME, PASSWORD, { proto: "https" })).headers.get("set-cookie")).toMatch(
      /; Secure/,
    );
  });

  it("400s a body that is not a username and password", async () => {
    expect((await POST(authRequest({ username: NAME }))).status).toBe(400);
  });
});

describe("POST /api/auth — the rate limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`429s with Retry-After after ${LOGIN_FAILURE_LIMIT} wrong pairs from one address, even for the right pair`, async () => {
    // Only the clock is frozen — scrypt runs on the thread pool, not on timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T14:00:00Z"));
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      expect((await signIn(NAME, "wrong password number")).status).toBe(401);
    }
    const res = await signIn();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(LOGIN_FAILURE_WINDOW_MS / 1000));
    expect(await res.json()).toMatchObject({ rateLimited: true, retryAfterSeconds: LOGIN_FAILURE_WINDOW_MS / 1000 });
    expect(sessionRows()).toBe(0);
    // Another address is not locked by this one.
    expect((await signIn(NAME, PASSWORD, { address: "203.0.113.9" })).status).toBe(200);
  });

  it("a success resets the address's count", async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) await signIn(NAME, "wrong password number");
    expect((await signIn()).status).toBe(200);
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) await signIn(NAME, "wrong password number");
    expect((await signIn()).status).toBe(200);
  });

  it("50 simultaneous wrong sign-ins run at most 5 checks; every other one is a 429", async () => {
    const verify = vi.mocked(verifyWebAccount);
    verify.mockClear();
    const flood = 50;
    const results = await Promise.all(
      Array.from({ length: flood }, () => signIn(NAME, "wrong password number")),
    );
    const ran = verify.mock.calls.length;
    expect(ran).toBeGreaterThanOrEqual(1);
    expect(ran).toBeLessThanOrEqual(LOGIN_FAILURE_LIMIT);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(ran);
    expect(statuses.filter((s) => s === 429)).toHaveLength(flood - ran);
    expect(sessionRows()).toBe(0);
  });

  it("a right pair arriving while a check runs is told to retry in a second, then signs in", async () => {
    const verify = vi.mocked(verifyWebAccount);
    let release!: () => void;
    verify.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      return false;
    });
    const parked = signIn(NAME, "wrong password number");
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));

    const busy = await signIn();
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.json()).toMatchObject({ rateLimited: true, lockout: "busy", retryAfterSeconds: 1 });

    release();
    expect((await parked).status).toBe(401);
    expect((await signIn()).status).toBe(200);
  });

  it("says a lockout is the whole server's when the global ceiling holds", async () => {
    await floodFromForgedAddresses();
    const res = await signIn();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ lockout: "server" });
  });

  it("logs a lockout with the client-named address cut to 64 characters", async () => {
    const address = "x".repeat(500);
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await signIn(NAME, "wrong password number", { address });
    const line = vi.mocked(log.warn).mock.calls.map((c) => String(c[1])).find((m) => m.includes("locked"));
    expect(line).toBeDefined();
    expect(line).toContain("x".repeat(64));
    expect(line).not.toContain("x".repeat(65));
  });
});

describe("POST /api/auth — resume (no body)", () => {
  it("answers signed-in for a live cookie and mints nothing", async () => {
    const token = cookieToken(await signIn());
    const res = await POST(authRequest(undefined, { cookie: token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ signedIn: true });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(sessionRows()).toBe(1);
  });

  it("asks for a sign-in without a session — it is not a mint", async () => {
    const res = await POST(authRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ signInRequired: true });
    expect(sessionRows()).toBe(0);
  });

  it("still runs the broker check, so a dead broker reads as an error, not as signed in", async () => {
    const token = cookieToken(await signIn());
    plugins.tradovate.hasLiveToken.mockReturnValue(false);
    const res = await POST(authRequest(undefined, { cookie: token }));
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("signedIn");
  });
});

describe("POST /api/auth/logout", () => {
  it("drops the session and clears the cookie", async () => {
    const token = cookieToken(await signIn());
    const other = createSession();
    const res = await LOGOUT(new NextRequest("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^crossfire_session=; Max-Age=0/);
    expect(validateSession(token)).toBe(false);
    expect(validateSession(other)).toBe(true);
  });

  it("is gated — no session, nothing to sign out of", async () => {
    const res = await LOGOUT(new NextRequest("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/password", () => {
  const NEXT = "a different passphrase";

  function change(token: string, body: unknown) {
    return CHANGE_PASSWORD(new NextRequest("http://localhost/api/auth/password", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-forwarded-for": ADDRESS },
      body: JSON.stringify(body),
    }));
  }

  it("needs the current password", async () => {
    const token = cookieToken(await signIn());
    const res = await change(token, { currentPassword: "not the password", newPassword: NEXT });
    expect(res.status).toBe(403);
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(true);
  });

  it("changes it, keeps the caller signed in and signs every other session out", async () => {
    const token = cookieToken(await signIn());
    const other = createSession();
    const res = await change(token, { currentPassword: PASSWORD, newPassword: NEXT });
    expect(res.status).toBe(200);
    expect(await verifyWebAccount(NAME, NEXT)).toBe(true);
    expect(validateSession(token)).toBe(true);
    expect(validateSession(other)).toBe(false);
  });

  it("400s a new password under the length rule", async () => {
    const token = cookieToken(await signIn());
    expect((await change(token, { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
  });

  it("is gated", async () => {
    expect((await change("not-a-session", { currentPassword: PASSWORD, newPassword: NEXT })).status).toBe(401);
  });

  it("is not locked by the global ceiling — a flood of forged sign-ins cannot stop the owner changing it", async () => {
    const token = cookieToken(await signIn());
    await floodFromForgedAddresses();
    expect((await signIn()).status).toBe(429);
    expect((await change(token, { currentPassword: PASSWORD, newPassword: NEXT })).status).toBe(200);
  });

  it("still counts wrong current passwords against the caller's session", async () => {
    const token = cookieToken(await signIn());
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      expect((await change(token, { currentPassword: "not the password", newPassword: NEXT })).status).toBe(403);
    }
    const res = await change(token, { currentPassword: PASSWORD, newPassword: NEXT });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ lockout: "address" });
  });

  it("a borrowed session forging a new address per guess still hits the limit — the count is the session's", async () => {
    const token = cookieToken(await signIn());
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_GLOBAL_FAILURE_LIMIT; i++) {
      const res = await CHANGE_PASSWORD(new NextRequest("http://localhost/api/auth/password", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-forwarded-for": `forged-${i}` },
        body: JSON.stringify({ currentPassword: "not the password", newPassword: NEXT }),
      }));
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 403)).toHaveLength(LOGIN_FAILURE_LIMIT);
    expect(statuses.slice(LOGIN_FAILURE_LIMIT).every((s) => s === 429)).toBe(true);
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(true);
  });
});
