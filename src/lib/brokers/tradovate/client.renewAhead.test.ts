import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module-level mocks (hoisted before any import) ──────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  recordOrderMapping: vi.fn(),
  recordOrderMappings: vi.fn(),
}));

vi.mock("@/lib/brokers/tradovate/penalty", () => ({
  PenaltyResponseHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this["assertCircuitClosed"] = vi.fn();
    this["handle"] = vi.fn().mockResolvedValue({ kind: "ok" });
  }),
}));

vi.mock("@/lib/env", () => ({
  isProductionEnv: vi.fn().mockReturnValue(false),
  isStagingEnv: vi.fn().mockReturnValue(false),
}));

import { log } from "@/lib/logger";
import { resetLogBursts } from "@/lib/logging/pipe";
import {
  RENEW_AHEAD_MS,
  RENEW_AHEAD_RETRY_MS,
  RENEW_AHEAD_SOON_MS,
  TradovateClient,
  type TradovateCredentialBundle,
} from "./client";

// ── Helpers ──────────────────────────────────────────────────────────────────

// A Tuesday, 10:00 ET — inside the CME session; the client reads no calendar,
// the instant only anchors the token expiries below.
const NOW = Date.parse("2026-10-27T14:00:00.000Z");
const MIN = 60_000;
const TOKEN_LIFE_MS = 90 * MIN;

const BASE = "http://tradovate.test";
const RENEW_URL = `${BASE}/auth/renewAccessToken`;
const MINT_URL = `${BASE}/auth/accessTokenRequest`;

const CREDS: TradovateCredentialBundle = {
  username: "user",
  password: "pass",
  apiCid: "1",
  apiSecret: "sec",
  appId: "app",
  appVersion: "1.0.0",
  deviceId: "dev",
};

interface RecordedCall {
  url: string;
  method: string | undefined;
  authorization: string | undefined;
}

type Responder = (url: string) => Response;

interface LoggedEvent {
  event: string;
  message: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function token(name: string, expiresAt: number): Response {
  return json({ accessToken: name, expirationTime: new Date(expiresAt).toISOString() });
}

/** Stub `fetch`, record every call, answer each by URL. */
function stubFetch(respond: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method, authorization: headers["Authorization"] });
      return respond(url);
    }),
  );
  return calls;
}

/** A client built as an engine process's plugin builds it. */
function renewingClient(): TradovateClient {
  return new TradovateClient(BASE, CREDS, { renewAhead: true });
}

/** Mint once at NOW with a token expiring `expiresAt`, then answer renewals
 *  with `renewal`. */
async function mintedClient(
  expiresAt: number,
  renewal: Responder,
): Promise<{ client: TradovateClient; calls: RecordedCall[] }> {
  const calls = stubFetch((url) => (url === MINT_URL ? token("minted", expiresAt) : renewal(url)));
  const client = renewingClient();
  await client.authenticate();
  return { client, calls };
}

function urls(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.url);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TradovateClient — renew ahead of expiry", () => {
  let events: LoggedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetLogBursts();
    events = [];
    const real = log.event;
    vi.spyOn(log, "event").mockImplementation((event, tag, message, subject) => {
      events.push({ event, message });
      real(event, tag, message, subject);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fires at expiresAt − 15 min, and the request it makes is the GET renewal", async () => {
    const expiresAt = NOW + TOKEN_LIFE_MS;
    const { client, calls } = await mintedClient(expiresAt, () =>
      token("renewed", Date.now() + TOKEN_LIFE_MS),
    );

    await vi.advanceTimersByTimeAsync(expiresAt - RENEW_AHEAD_MS - NOW - 1);
    expect(urls(calls)).toEqual([MINT_URL]);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);
    expect(calls[1].method).toBe("GET");
    expect(calls[1].authorization).toBe("Bearer minted");
    expect(client.getToken()).toBe("renewed");
    client.dispose();
  });

  it("a successful renewal re-arms for the new token's expiry", async () => {
    const firstDue = NOW + TOKEN_LIFE_MS - RENEW_AHEAD_MS;
    const renewedExpiry = firstDue + TOKEN_LIFE_MS;
    const { client, calls } = await mintedClient(NOW + TOKEN_LIFE_MS, () =>
      token("renewed", renewedExpiry),
    );
    await vi.advanceTimersByTimeAsync(firstDue - NOW);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);

    await vi.advanceTimersByTimeAsync(renewedExpiry - RENEW_AHEAD_MS - firstDue - 1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, RENEW_URL]);
    expect(calls[2].authorization).toBe("Bearer renewed");
    client.dispose();
  });

  it("a p-time on the renewal re-arms for the end of the window, makes no login, and warns once", async () => {
    const P_TIME_SEC = 30;
    let renewals = 0;
    const { client, calls } = await mintedClient(NOW + TOKEN_LIFE_MS, () =>
      ++renewals === 1
        ? json({ "p-ticket": "t", "p-time": P_TIME_SEC })
        : token("renewed", Date.now() + TOKEN_LIFE_MS),
    );
    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS - RENEW_AHEAD_MS);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);
    expect(events.filter((e) => e.event === "broker_penalty")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(P_TIME_SEC * 1000 - 1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, RENEW_URL]);
    expect(client.getToken()).toBe("renewed");
    expect(events.filter((e) => e.event === "broker_penalty")).toHaveLength(1);
    client.dispose();
  });

  it("a renewal whose mint fallback also fails re-arms after the backoff and warns once", async () => {
    let failing = true;
    const calls = stubFetch((url) => {
      if (url === MINT_URL && calls.length === 1) return token("minted", NOW + TOKEN_LIFE_MS);
      if (failing) return new Response("", { status: url === RENEW_URL ? 404 : 503 });
      return token("renewed", Date.now() + TOKEN_LIFE_MS);
    });
    const client = renewingClient();
    await client.authenticate();

    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS - RENEW_AHEAD_MS);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, MINT_URL]);
    expect(events.filter((e) => e.event === "broker_auth_failed")).toHaveLength(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(RENEW_AHEAD_RETRY_MS - 1);
    expect(calls).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, MINT_URL, RENEW_URL]);
    expect(client.getToken()).toBe("renewed");
    expect(events.filter((e) => e.event === "broker_auth_failed")).toHaveLength(1);
    client.dispose();
  });

  it("dispose clears the timer: no request after it", async () => {
    const { client, calls } = await mintedClient(NOW + TOKEN_LIFE_MS, () =>
      token("renewed", Date.now() + TOKEN_LIFE_MS),
    );
    expect(vi.getTimerCount()).toBe(1);

    client.dispose();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS * 2);
    expect(urls(calls)).toEqual([MINT_URL]);
  });

  it("dispose during a renewal in flight leaves nothing armed when it lands", async () => {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = stubFetch((url) =>
      url === MINT_URL ? token("minted", NOW + TOKEN_LIFE_MS) : token("renewed", Date.now() + TOKEN_LIFE_MS),
    );
    const client = renewingClient();
    await client.authenticate();
    const fetchStub = vi.mocked(fetch);
    const answer = fetchStub.getMockImplementation()!;
    fetchStub.mockImplementation(async (input, init) => {
      await parked;
      return answer(input, init);
    });

    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS - RENEW_AHEAD_MS);
    client.dispose();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a token with under 15 min left arms for now plus the short delay", async () => {
    const { client, calls } = await mintedClient(NOW + 10 * MIN, () =>
      token("renewed", Date.now() + TOKEN_LIFE_MS),
    );

    await vi.advanceTimersByTimeAsync(RENEW_AHEAD_SOON_MS - 1);
    expect(urls(calls)).toEqual([MINT_URL]);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);
    client.dispose();
  });

  it("a renewal that leaves the token inside the window waits the backoff, not the short delay", async () => {
    // A server clock far ahead of ours makes every answer look short-lived;
    // the short delay would then renew every 15 s, past Tradovate's 15/h.
    const { client, calls } = await mintedClient(NOW + 10 * MIN, () =>
      token("renewed", Date.now() + 10 * MIN),
    );
    await vi.advanceTimersByTimeAsync(RENEW_AHEAD_SOON_MS);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(RENEW_AHEAD_RETRY_MS - 1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, RENEW_URL]);
    client.dispose();
  });

  it("an already-expired token arms nothing", async () => {
    const { calls } = await mintedClient(NOW - MIN, () =>
      token("renewed", Date.now() + TOKEN_LIFE_MS),
    );

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS);
    expect(urls(calls)).toEqual([MINT_URL]);
  });

  it("the armed timer is unref'd, so it never holds the process open", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const expiresAt = NOW + TOKEN_LIFE_MS;
    const { client } = await mintedClient(expiresAt, () => token("renewed", Date.now() + TOKEN_LIFE_MS));

    const armIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === expiresAt - RENEW_AHEAD_MS - NOW);
    expect(armIndex).toBeGreaterThanOrEqual(0);
    const timer = setTimeoutSpy.mock.results[armIndex].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    client.dispose();
  });

  it("a p-time longer than the token's remaining life arms nothing and makes no login", async () => {
    // At the fire the token has RENEW_AHEAD_MS left; a wait past that would
    // land after expiry, where a renewal is refused.
    const P_TIME_SEC = RENEW_AHEAD_MS / 1000 + 60;
    const { calls } = await mintedClient(NOW + TOKEN_LIFE_MS, () => json({ "p-ticket": "t", "p-time": P_TIME_SEC }));

    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS - RENEW_AHEAD_MS);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);
    expect(events.filter((e) => e.event === "broker_penalty")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS * 2);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL]);
  });

  it("a p-time on the fallback login re-arms for the end of that window, with no second login", async () => {
    const P_TIME_SEC = 30;
    let mints = 0;
    const calls = stubFetch((url) => {
      if (url === RENEW_URL) {
        return mints === 1 ? new Response("", { status: 404 }) : token("renewed", Date.now() + TOKEN_LIFE_MS);
      }
      return ++mints === 1 ? token("minted", NOW + TOKEN_LIFE_MS) : json({ "p-ticket": "t", "p-time": P_TIME_SEC });
    });
    const client = renewingClient();
    await client.authenticate();

    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS - RENEW_AHEAD_MS);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, MINT_URL]);
    expect(events.filter((e) => e.event === "broker_penalty")).toHaveLength(1);
    expect(events.filter((e) => e.event === "broker_auth_failed")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(P_TIME_SEC * 1000 - 1);
    expect(calls).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, MINT_URL, RENEW_URL]);
    expect(client.getToken()).toBe("renewed");
    client.dispose();
  });

  it("a captcha answer stops the timer for good and warns once — never retried", async () => {
    let mints = 0;
    const calls = stubFetch((url) => {
      if (url === MINT_URL && ++mints === 1) return token("minted", NOW + TOKEN_LIFE_MS);
      return json({ "p-captcha": "required", "p-ticket": "t" });
    });
    const client = renewingClient();
    await client.authenticate();

    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS - RENEW_AHEAD_MS);
    expect(urls(calls)).toEqual([MINT_URL, RENEW_URL, MINT_URL]);
    expect(vi.getTimerCount()).toBe(0);
    const warned = events.filter((e) => e.event === "broker_auth_failed");
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain("captcha");

    await vi.advanceTimersByTimeAsync(RENEW_AHEAD_MS + RENEW_AHEAD_RETRY_MS * 3);
    expect(calls).toHaveLength(3);
    expect(events.filter((e) => e.event === "broker_auth_failed")).toHaveLength(1);
    client.dispose();
  });

  it("a client built without renewAhead arms nothing — the web process's", async () => {
    const calls = stubFetch((url) => (url === MINT_URL ? token("minted", NOW + TOKEN_LIFE_MS) : token("renewed", NOW)));
    const client = new TradovateClient(BASE, CREDS);
    await client.authenticate();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS * 2);
    expect(urls(calls)).toEqual([MINT_URL]);
  });

  it("a client that never authenticated arms nothing", async () => {
    const calls = stubFetch(() => new Response("", { status: 503 }));
    const unauthenticated = renewingClient();
    await expect(unauthenticated.authenticate()).rejects.toThrow();

    const withSetToken = renewingClient();
    withSetToken.setToken("external");

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TOKEN_LIFE_MS * 2);
    expect(urls(calls)).toEqual([MINT_URL]);
  });
});
