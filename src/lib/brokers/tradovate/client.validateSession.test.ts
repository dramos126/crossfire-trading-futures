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

import { resetLogBursts } from "@/lib/logging/pipe";
import { TradovateClient, type TradovateCredentialBundle } from "./client";
import { TradovateAuthPenaltyError } from "./errors";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  body: RequestInit["body"];
}

type Responder = (url: string) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub `fetch`, record every call, answer each by URL. */
function stubFetch(respond: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method,
        authorization: headers["Authorization"],
        body: init?.body,
      });
      return respond(url);
    }),
  );
  return calls;
}

function clientWithToken(token: string): TradovateClient {
  const client = new TradovateClient(BASE, CREDS);
  client.setToken(token);
  return client;
}

const RENEWED_EXPIRY = "2030-01-01T00:00:00.000Z";
const MINTED_EXPIRY = "2031-01-01T00:00:00.000Z";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TradovateClient.validateSession — renewal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLogBursts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renews with GET /auth/renewAccessToken, the current token as Bearer, and no body", async () => {
    const calls = stubFetch(async () =>
      json({ accessToken: "renewed", expirationTime: RENEWED_EXPIRY }),
    );
    const client = clientWithToken("current-token");

    await client.validateSession();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RENEW_URL);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].authorization).toBe("Bearer current-token");
    expect(calls[0].body).toBeUndefined();
  });

  it("a successful renewal replaces the token, expiry and a returned userId", async () => {
    // Tradovate's documented renewal answer: no mdAccessToken; userId optional.
    stubFetch(async () =>
      json({ accessToken: "renewed", expirationTime: RENEWED_EXPIRY, userId: 42 }),
    );
    const client = clientWithToken("current-token");

    const state = await client.validateSession();

    expect(state.accessToken).toBe("renewed");
    expect(client.getToken()).toBe("renewed");
    expect(client.getUserId()).toBe(42);
    expect(client.getTokenExpiresAt()).toBe(Date.parse(RENEWED_EXPIRY));
  });

  it("a renewal answer without mdAccessToken or userId keeps the minted values", async () => {
    const calls = stubFetch(async (url) =>
      url === MINT_URL
        ? json({
            accessToken: "minted",
            mdAccessToken: "md-minted",
            expirationTime: MINTED_EXPIRY,
            userId: 7,
          })
        : json({ accessToken: "renewed", expirationTime: RENEWED_EXPIRY }),
    );
    const client = new TradovateClient(BASE, CREDS);
    await client.authenticate();

    await client.validateSession();

    expect(calls.map((c) => c.url)).toEqual([MINT_URL, RENEW_URL]);
    expect(client.getToken()).toBe("renewed");
    expect(client.getTokenExpiresAt()).toBe(Date.parse(RENEWED_EXPIRY));
    expect(client.getMdAccessToken()).toBe("md-minted");
    expect(client.getUserId()).toBe(7);
  });

  it("a mint answer without mdAccessToken or userId clears the earlier values", async () => {
    // The keep-earlier rule is the renewal's only: a mint is a new session.
    let mints = 0;
    stubFetch(async () =>
      ++mints === 1
        ? json({
            accessToken: "first",
            mdAccessToken: "md-first",
            expirationTime: MINTED_EXPIRY,
            userId: 7,
          })
        : json({ accessToken: "second", expirationTime: MINTED_EXPIRY }),
    );
    const client = new TradovateClient(BASE, CREDS);
    await client.authenticate();

    await client.authenticate();

    expect(client.getToken()).toBe("second");
    expect(client.getMdAccessToken()).toBeNull();
    expect(client.getUserId()).toBeNull();
  });

  it("a renewal answered with p-time throws TradovateAuthPenaltyError and never logs in", async () => {
    const calls = stubFetch(async (url) =>
      url === RENEW_URL
        ? json({ "p-ticket": "t", "p-time": 30 })
        : json({ accessToken: "minted", expirationTime: MINTED_EXPIRY }),
    );
    const client = clientWithToken("current-token");

    const err = await client.validateSession().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TradovateAuthPenaltyError);
    expect(calls.map((c) => c.url)).toEqual([RENEW_URL]);
    expect(client.getToken()).toBe("current-token");
  });

  it("a renewal answered with an error envelope is rejected by the consumer and falls back to a mint", async () => {
    // Proves the renewal response goes through consumeAuthResponse: only
    // that consumer turns a 200 `errorText` into a failure.
    const calls = stubFetch(async (url) =>
      url === RENEW_URL
        ? json({ errorText: "Expired Access Token" })
        : json({ accessToken: "minted", expirationTime: MINTED_EXPIRY }),
    );
    const client = clientWithToken("current-token");

    await client.validateSession();

    expect(calls.map((c) => c.url)).toEqual([RENEW_URL, MINT_URL]);
    expect(client.getToken()).toBe("minted");
  });

  it.each([
    ["a 401", async (): Promise<Response> => new Response("", { status: 401 })],
    [
      "a network error",
      async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "a renewal that fails with %s falls through to authenticate() exactly once, and the guard clears",
    async (_label, failRenewal) => {
      const calls = stubFetch(async (url) =>
        url === RENEW_URL
          ? failRenewal()
          : json({ accessToken: "minted", expirationTime: MINTED_EXPIRY }),
      );
      const client = clientWithToken("current-token");

      const state = await client.validateSession();

      expect(state.accessToken).toBe("minted");
      expect(calls.map((c) => c.url)).toEqual([RENEW_URL, MINT_URL]);
      expect(calls[1].method).toBe("POST");

      // Guard cleared: a second call starts a fresh renewal with the minted
      // token rather than returning the settled promise.
      await client.validateSession();
      expect(calls.map((c) => c.url)).toEqual([RENEW_URL, MINT_URL, RENEW_URL, MINT_URL]);
      expect(calls[2].authorization).toBe("Bearer minted");
    },
  );

  it("concurrent callers share one renewal request", async () => {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = stubFetch(async () => {
      await parked;
      return json({ accessToken: "renewed", expirationTime: RENEWED_EXPIRY });
    });
    const client = clientWithToken("current-token");

    const first = client.validateSession();
    const second = client.validateSession();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    expect(a.accessToken).toBe("renewed");
    expect(b.accessToken).toBe("renewed");
  });
});
