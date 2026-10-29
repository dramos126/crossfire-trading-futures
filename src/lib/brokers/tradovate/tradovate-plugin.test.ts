import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => { throw new Error("getDb() not available in test"); }),
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
  setTradovateUsername: vi.fn(),
  setTradovatePassword: vi.fn(),
  setTradovateApiCid: vi.fn(),
  setTradovateApiSecret: vi.fn(),
  setTradovateAppId: vi.fn(),
  setTradovateAppVersion: vi.fn(),
  setTradovateDeviceId: vi.fn(),
}));

// Controls authenticate() outcome on a per-test basis
const mockAuthenticate = vi.fn().mockResolvedValue(undefined);
const mockGetTokenExpiresAt = vi.fn().mockReturnValue(9999999999);
const mockGetMdAccessToken = vi.fn().mockReturnValue("md-token");
/** Every client the plugin constructed, in order, with its own `dispose` and
 *  the arguments it was built with. */
const mockConstructedClients: Array<{ dispose: ReturnType<typeof vi.fn>; constructedWith: unknown[] }> = [];

vi.mock("@/lib/brokers/tradovate/client", () => {
  const readTradovateCredentialsFromDb = vi.fn().mockReturnValue(null);
  class TradovateClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticate: (...args: any[]) => Promise<void>;
    getTokenExpiresAt: () => number;
    getMdAccessToken: () => string | null;
    dispose = vi.fn();
    constructedWith: unknown[];
    constructor(...args: unknown[]) {
      this.constructedWith = args;
      this.authenticate = mockAuthenticate;
      this.getTokenExpiresAt = mockGetTokenExpiresAt;
      this.getMdAccessToken = mockGetMdAccessToken;
      mockConstructedClients.push(this);
    }
  }
  return { TradovateClient, readTradovateCredentialsFromDb };
});

vi.mock("@/lib/trading/broker-access/broker-registry", () => ({
  BrokerRegistry: {
    tradovateExpected: vi.fn().mockReturnValue(true),
  },
}));

const mockSendDiscordAlert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notify/discord", () => ({
  sendDiscordAlert: (...args: unknown[]) => mockSendDiscordAlert(...args),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
  sendOrphanAlert: vi.fn().mockResolvedValue(undefined),
  formatNyTime: vi.fn().mockReturnValue(""),
  formatAccountLabel: vi.fn().mockReturnValue(""),
  COLOR_CONNECTION_LOST: 0,
  COLOR_CONNECTION_RESTORED: 0,
  COLOR_ORPHAN: 0,
  COLOR_ENTRY_LONG: 0,
  COLOR_ENTRY_SHORT: 0,
  COLOR_EXIT_WIN: 0,
  COLOR_EXIT_LOSS: 0,
  COLOR_EXIT_FLAT: 0,
  COLOR_EXIT_BE: 0,
  COLOR_EXIT_TRAIL: 0,
  COLOR_EXIT_STRATEGY: 0,
  COLOR_EXIT_MANUAL: 0,
  COLOR_BRACKET_FAILURE: 0,
  ansiGreen: (s: string) => s,
  ansiRed: (s: string) => s,
  ansiBlue: (s: string) => s,
  ansiGray: (s: string) => s,
  ANSI_LINE_WIDTH: 80,
  padAnsiLine: (s: string) => s,
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

const mockSetTradovateCredsValidatedSignature = vi.fn();
const mockSetTradovateCredsValidatedAt = vi.fn();

vi.mock("@/lib/db/cred-validation", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/db/cred-validation")>();
  return {
    // Real hash — no DB dependency
    computeTradovateCredsSignature: actual.computeTradovateCredsSignature,
    setTradovateCredsValidatedSignature: (...args: unknown[]) => mockSetTradovateCredsValidatedSignature(...args),
    setTradovateCredsValidatedAt: (...args: unknown[]) => mockSetTradovateCredsValidatedAt(...args),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { TradovateBrokerPlugin } from "./index";
import { readTradovateCredentialsFromDb, TradovateClient } from "@/lib/brokers/tradovate/client";
import {
  getTradovateApiCid,
  getTradovateDeviceId,
  setTradovateUsername,
  setTradovatePassword,
  setTradovateApiCid,
  setTradovateApiSecret,
  setTradovateAppId,
  setTradovateAppVersion,
  setTradovateDeviceId,
} from "@/lib/db/settings";
import { BrokerRegistry } from "@/lib/trading/broker-access/broker-registry";
import {
  TradovateAuthPenaltyError,
  TradovateCaptchaLockoutError,
  TradovateCircuitOpenError,
  TradovateOrderRejectionError,
  TradovateUnauthorizedError,
  isAlreadyTerminalCancelRejection,
} from "@/lib/brokers/tradovate/errors";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_CREDS = { username: "u", password: "p", apiCid: "c", apiSecret: "s", appId: "a", appVersion: "1", deviceId: "d" };

/** Poke private fields on the plugin instance — test-only invariant verification. */
function pluginPrivate(plugin: TradovateBrokerPlugin): Record<string, unknown> {
  return plugin as unknown as Record<string, unknown>;
}

function freshPlugin(): TradovateBrokerPlugin {
  return new TradovateBrokerPlugin();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
  vi.mocked(getTradovateApiCid).mockReturnValue(null);
  vi.mocked(getTradovateDeviceId).mockReturnValue(null);
  vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue(undefined);
  mockGetTokenExpiresAt.mockReturnValue(9999999999);
  mockGetMdAccessToken.mockReturnValue("md-token");
  mockSendDiscordAlert.mockClear();
  mockSendDiscordAlert.mockResolvedValue(undefined);
  vi.mocked(setTradovateUsername).mockReset();
  vi.mocked(setTradovatePassword).mockReset();
  vi.mocked(setTradovateApiCid).mockReset();
  vi.mocked(setTradovateApiSecret).mockReset();
  vi.mocked(setTradovateAppId).mockReset();
  vi.mocked(setTradovateAppVersion).mockReset();
  vi.mocked(setTradovateDeviceId).mockReset();
  mockSetTradovateCredsValidatedSignature.mockReset();
  mockSetTradovateCredsValidatedAt.mockReset();
  mockConstructedClients.length = 0;
});

// ── A dropped client stops renewing ───────────────────────────────────────────

// The client renews its token ahead of expiry on its own timer, so every
// place the plugin lets go of one must dispose it — an undisposed client
// keeps renewing a token nothing uses, holding a Tradovate session open.
describe("TradovateBrokerPlugin — a client it drops is disposed", () => {
  it("invalidate disposes the client it drops", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    await plugin.initialize();
    const [client] = mockConstructedClients;

    plugin.invalidate();

    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it("credentials removed from the DB dispose the client", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    await plugin.initialize();
    const [client] = mockConstructedClients;

    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it("a client kept for a network retry is disposed when a later login nulls it", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    await plugin.initialize();
    plugin.invalidate();
    mockAuthenticate.mockRejectedValueOnce(new Error("fetch failed"));
    await plugin.initialize();
    const kept = mockConstructedClients[1];
    expect(plugin.getClient()).toBe(kept);

    mockAuthenticate.mockRejectedValueOnce(new TradovateAuthPenaltyError(5));
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
    expect(kept.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["succeeds", (): void => undefined],
    ["fails", (): void => void mockAuthenticate.mockRejectedValueOnce(new Error("bad"))],
  ])("testConnection disposes its own client when the login %s", async (_label, arrange) => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    arrange();

    await freshPlugin().testConnection().catch(() => null);

    expect(mockConstructedClients).toHaveLength(1);
    expect(mockConstructedClients[0].dispose).toHaveBeenCalledTimes(1);
  });

  // A new drop site written without `dispose()` would leave a client renewing
  // a session nothing uses. Enumerated from source so a site added later is
  // covered without anyone remembering this test.
  it("every `this._client = null` in the plugin is preceded by a dispose of that client", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const lines = source.split("\n");
    const isCode = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("//");
    const assignments = lines.flatMap((line, i) => (/\bthis\._client\s*=(?!=)/.test(line) ? [i] : []));
    const drops = assignments.filter((i) => /\bthis\._client\s*=\s*null\s*;/.test(lines[i]));

    expect(drops.length).toBeGreaterThanOrEqual(3);
    for (const i of drops) {
      const previous = lines.slice(0, i).reverse().find(isCode);
      expect(previous?.trim(), `index.ts:${i + 1}`).toBe("this._client?.dispose();");
    }
    // Every other assignment is the one guarded construction, which replaces
    // nothing; any new shape fails here and needs a decision.
    const others = assignments.filter((i) => !drops.includes(i)).map((i) => lines[i].trim());
    expect(others).toEqual([
      "if (!this._client) this._client = new TradovateClient(undefined, null, { renewAhead: runsEngine() });",
    ]);
  });
});

// ── Only an engine process renews ahead ──────────────────────────────────────

// Tradovate keeps two sessions per user and closes the oldest on a third. A
// web process logs in for the UI; renewed ahead, that login would hold one of
// the two for good instead of lapsing ~90 min after the last UI hit.
describe("TradovateBrokerPlugin — the renew-ahead flag follows the role", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function builtWithRenewAhead(): unknown {
    const options = mockConstructedClients[0]?.constructedWith[2] as { renewAhead?: unknown } | undefined;
    return options?.renewAhead;
  }

  it("a web process builds its client with no renew-ahead timer", async () => {
    vi.stubEnv("CROSSFIRE_ROLE", "web");
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    await freshPlugin().initialize();

    expect(mockConstructedClients).toHaveLength(1);
    expect(builtWithRenewAhead()).toBe(false);
  });

  it.each(["engine", "all", ""])("a process in role %j builds its client renewing ahead", async (role) => {
    vi.stubEnv("CROSSFIRE_ROLE", role);
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    await freshPlugin().initialize();

    expect(mockConstructedClients).toHaveLength(1);
    expect(builtWithRenewAhead()).toBe(true);
  });

  it("testConnection's throwaway client never renews ahead, in any role", async () => {
    vi.stubEnv("CROSSFIRE_ROLE", "engine");
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    await freshPlugin().testConnection();

    expect(mockConstructedClients).toHaveLength(1);
    expect(builtWithRenewAhead()).not.toBe(true);
  });
});

// ── isConfigured ──────────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.isConfigured", () => {
  it("returns false when getTradovateApiCid returns null", () => {
    vi.mocked(getTradovateApiCid).mockReturnValue(null);
    expect(freshPlugin().isConfigured()).toBe(false);
  });

  it("returns true when getTradovateApiCid returns a non-empty string", () => {
    vi.mocked(getTradovateApiCid).mockReturnValue("my-cid");
    expect(freshPlugin().isConfigured()).toBe(true);
  });
});

// ── isExpected ────────────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.isExpected", () => {
  it("returns false when BrokerRegistry.tradovateExpected returns false", () => {
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(false);
    expect(freshPlugin().isExpected()).toBe(false);
  });

  it("returns true when BrokerRegistry.tradovateExpected returns true", () => {
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);
    expect(freshPlugin().isExpected()).toBe(true);
  });
});

// ── initialize no-op when !isExpected ─────────────────────────────────────────

describe("TradovateBrokerPlugin.initialize — no-op when !isExpected", () => {
  it("getClient returns null after initialize when isExpected is false, without calling authenticate", async () => {
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(false);
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});

// ── _everAuthenticated flag invariant ─────────────────────────────────────────

describe("TradovateBrokerPlugin — _everAuthenticated flag invariant", () => {
  it("first auth failure: getClient returns null (auto-pause contract)", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    mockAuthenticate.mockRejectedValueOnce(new Error("network error"));

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(false);
  });

  it("successful auth: getClient returns the client instance and _everAuthenticated is true", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(plugin.getClient()).toBeInstanceOf(TradovateClient);
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(true);
  });

  it("auth failure after prior success: getClient still returns the same instance (PenaltyResponseHandler preserved)", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    // First initialize succeeds
    await plugin.initialize();
    const firstClient = plugin.getClient();
    expect(firstClient).not.toBeNull();

    // Second initialize: authenticate fails
    mockAuthenticate.mockRejectedValueOnce(new Error("auth failure"));
    await plugin.initialize();

    // Client must be the same instance — discarding it would reset PenaltyResponseHandler
    expect(plugin.getClient()).toBe(firstClient);
  });

  it("invalidate resets _everAuthenticated to false so next auth failure nulls the client again", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    // Establish a successful auth
    await plugin.initialize();
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(true);

    // Invalidate: clears client and resets flag
    plugin.invalidate();
    expect(plugin.getClient()).toBeNull();
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(false);

    // Now a fresh auth failure must null the client per first-failure contract
    mockAuthenticate.mockRejectedValueOnce(new Error("fail after invalidate"));
    await plugin.initialize();
    expect(plugin.getClient()).toBeNull();
  });

  it("A76: a re-login after a credential change that fails on the network keeps the client, so the next registry refresh retries", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    await plugin.initialize();

    plugin.invalidate();
    mockAuthenticate.mockRejectedValueOnce(new Error("fetch failed"));
    await plugin.initialize();

    // Non-null is what lets the engine re-attach: the registry's arm throws
    // and carries its accounts forward instead of dropping them, and the
    // client re-authenticates lazily on the next request.
    expect(plugin.getClient()).toBeInstanceOf(TradovateClient);
    expect(plugin.hasLiveToken()).toBe(false);
    expect(plugin.lastAuthError()).toBe("fetch failed");
  });

  it("A76: a re-login that fails on the credentials still nulls the client — no retry against a wrong password", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    await plugin.initialize();

    plugin.invalidate();
    mockAuthenticate.mockRejectedValueOnce(new TradovateAuthPenaltyError(5));
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
  });

  it("A76: a network failure on the first login of the process still nulls the client (boot auto-pause contract)", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    mockAuthenticate.mockRejectedValueOnce(new Error("fetch failed"));
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
  });

  it("cred removal (readTradovateCredentialsFromDb returns null): _client nulled and _everAuthenticated reset", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    // Establish authenticated state
    await plugin.initialize();
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(true);
    expect(plugin.getClient()).not.toBeNull();

    // Creds removed
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(false);
    // Alert throttle is also reset so a re-add gets a fresh window
    expect(pluginPrivate(plugin).lastTradovateAuthAlertAt).toBe(0);
  });

  it("keeps the reason a swallowed auth failure would otherwise lose", async () => {
    // `initialize()` never rethrows, so a null client is all a caller sees.
    // Routes render this instead of "Tradovate is not configured".
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    mockAuthenticate.mockRejectedValueOnce(
      new TradovateCaptchaLockoutError("/auth/accesstokenrequest", null),
    );

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
    expect(plugin.lastAuthError()).toContain("p-captcha lockout");
  });

  it("clears the retained reason once authentication succeeds", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    mockAuthenticate.mockRejectedValueOnce(new Error("network error"));

    const plugin = freshPlugin();
    await plugin.initialize();
    expect(plugin.lastAuthError()).toBe("network error");

    await plugin.initialize();
    expect(plugin.lastAuthError()).toBeNull();
  });

  it("reports no reason when credentials are simply absent", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.initialize();

    // Null client plus null reason is the genuine not-configured case.
    expect(plugin.getClient()).toBeNull();
    expect(plugin.lastAuthError()).toBeNull();
  });

  it("multiple successful initializes reuse the same client instance without re-construction", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    await plugin.initialize();
    const first = plugin.getClient();
    await plugin.initialize();
    const second = plugin.getClient();

    expect(second).toBe(first);
    // authenticate called twice (once per initialize) but always on the same instance
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });
});

// ── One login in flight ───────────────────────────────────────────────────────

// Every login opens one of the user's two Tradovate sessions. At a hand-off the
// takeover's fan-out logs in while a healthcheck's `getEngine()` can call
// `initialize()` too; the freshness guard cannot see a login still on the wire.
describe("TradovateBrokerPlugin.initialize — single-flight", () => {
  function deferredLogin(): { settle: (err?: Error) => void } {
    let settle: (err?: Error) => void = () => undefined;
    mockAuthenticate.mockImplementationOnce(
      () => new Promise<void>((resolve, reject) => {
        settle = (err) => (err ? reject(err) : resolve());
      }),
    );
    return { settle: (err) => settle(err) };
  }

  it("two concurrent initialize() calls make one login", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    const login = deferredLogin();

    const first = plugin.initialize();
    const second = plugin.initialize();
    login.settle();
    await Promise.all([first, second]);

    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockConstructedClients).toHaveLength(1);
  });

  it("a failed login does not latch: the next call logs in again", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    const login = deferredLogin();

    const first = plugin.initialize();
    const joined = plugin.initialize();
    login.settle(new Error("fetch failed"));
    await Promise.all([first, joined]);
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(plugin.getClient()).toBeNull();

    await plugin.initialize();

    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
    expect(plugin.getClient()).toBeInstanceOf(TradovateClient);
  });

  it("a call after invalidate() does not join the login on the old credentials", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    const plugin = freshPlugin();
    const oldLogin = deferredLogin();

    const stale = plugin.initialize();
    plugin.invalidate();
    await plugin.initialize();
    oldLogin.settle();
    await stale;

    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });
});

// ── Discord alert throttling ──────────────────────────────────────────────────

describe("TradovateBrokerPlugin — Discord alert throttling", () => {
  it("alert fires on first auth failure when Tradovate is expected", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);
    mockAuthenticate.mockRejectedValueOnce(new Error("timeout"));

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(mockSendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("alert is suppressed within AUTH_ALERT_SUPPRESSION_MS after the first alert", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);

    const plugin = freshPlugin();
    // First auth failure — fires the alert
    mockAuthenticate.mockRejectedValueOnce(new Error("fail1"));
    await plugin.initialize();
    expect(mockSendDiscordAlert).toHaveBeenCalledTimes(1);
    mockSendDiscordAlert.mockClear();

    // Second auth failure within the 5-minute window — must NOT fire
    mockAuthenticate.mockRejectedValueOnce(new Error("fail2"));
    await plugin.initialize();
    expect(mockSendDiscordAlert).not.toHaveBeenCalled();
  });

  it("alert fires again after the 5-minute suppression window expires", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);

    const plugin = freshPlugin();
    // Seed lastTradovateAuthAlertAt to 6 minutes ago
    const SIX_MINUTES_MS = 6 * 60 * 1000;
    pluginPrivate(plugin).lastTradovateAuthAlertAt = Date.now() - SIX_MINUTES_MS;

    mockAuthenticate.mockRejectedValueOnce(new Error("fail"));
    await plugin.initialize();

    expect(mockSendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("alert is NOT sent when BrokerRegistry.tradovateExpected returns false", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    // isExpected() = false → initialize() is a no-op, no auth runs
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(false);

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(mockSendDiscordAlert).not.toHaveBeenCalled();
  });

  it("alert is NOT sent when creds are missing (initialize returns early without auth attempt)", async () => {
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(mockSendDiscordAlert).not.toHaveBeenCalled();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});

// ── invalidate ────────────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.invalidate", () => {
  it("nulls _client and resets lastTradovateAuthAlertAt", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    await plugin.initialize();
    expect(plugin.getClient()).not.toBeNull();

    // Seed the alert throttle timestamp so we can verify it is cleared
    pluginPrivate(plugin).lastTradovateAuthAlertAt = Date.now();
    plugin.invalidate();

    expect(plugin.getClient()).toBeNull();
    expect(pluginPrivate(plugin).lastTradovateAuthAlertAt).toBe(0);
  });

  it("is safe to call before any initialize (no throw on null client)", () => {
    const plugin = freshPlugin();
    expect(() => plugin.invalidate()).not.toThrow();
    expect(plugin.getClient()).toBeNull();
  });
});

// ── credentialSchema ──────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.credentialSchema", () => {
  it("returns exactly 7 fields", () => {
    const schema = freshPlugin().credentialSchema();
    expect(schema).toHaveLength(7);
  });

  it("tradovatePassword has secret: true", () => {
    const schema = freshPlugin().credentialSchema();
    const f = schema.find((x) => x.key === "tradovatePassword")!;
    expect(f.secret).toBe(true);
  });

  it("tradovateApiCid has secret: false — it is an identifier, not a credential", () => {
    const schema = freshPlugin().credentialSchema();
    const f = schema.find((x) => x.key === "tradovateApiCid")!;
    expect(f.secret).toBe(false);
  });

  it("tradovateApiSecret has secret: true", () => {
    const schema = freshPlugin().credentialSchema();
    const f = schema.find((x) => x.key === "tradovateApiSecret")!;
    expect(f.secret).toBe(true);
  });

  it("tradovateUsername has secret: false", () => {
    const schema = freshPlugin().credentialSchema();
    const f = schema.find((x) => x.key === "tradovateUsername")!;
    expect(f.secret).toBe(false);
  });

  it("all required fields have required: true", () => {
    const schema = freshPlugin().credentialSchema();
    const requiredKeys = [
      "tradovateUsername",
      "tradovatePassword",
      "tradovateAppId",
      "tradovateAppVersion",
      "tradovateApiCid",
      "tradovateApiSecret",
    ];
    for (const key of requiredKeys) {
      const f = schema.find((x) => x.key === key)!;
      expect(f.required).toBe(true);
    }
  });

  it("tradovateDeviceId has required: false", () => {
    const schema = freshPlugin().credentialSchema();
    const f = schema.find((x) => x.key === "tradovateDeviceId")!;
    expect(f.required).toBe(false);
  });
});

// ── applyCredentials ──────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.applyCredentials", () => {
  it("calls setters for all 7 fields when all are provided with non-empty values", async () => {
    const plugin = freshPlugin();
    await plugin.applyCredentials({
      tradovateUsername: "user",
      tradovatePassword: "pass",
      tradovateApiCid: "cid",
      tradovateApiSecret: "secret",
      tradovateAppId: "app",
      tradovateAppVersion: "1.0",
      tradovateDeviceId: "device-uuid",
    });

    expect(setTradovateUsername).toHaveBeenCalledWith("user");
    expect(setTradovatePassword).toHaveBeenCalledWith("pass");
    expect(setTradovateApiCid).toHaveBeenCalledWith("cid");
    expect(setTradovateApiSecret).toHaveBeenCalledWith("secret");
    expect(setTradovateAppId).toHaveBeenCalledWith("app");
    expect(setTradovateAppVersion).toHaveBeenCalledWith("1.0");
    expect(setTradovateDeviceId).toHaveBeenCalledWith("device-uuid");
  });

  it("skips setter when key is absent from fields (leave-alone)", async () => {
    const plugin = freshPlugin();
    await plugin.applyCredentials({ tradovateUsername: "user" });

    expect(setTradovatePassword).not.toHaveBeenCalled();
    expect(setTradovateApiCid).not.toHaveBeenCalled();
  });

  it("calls setter with null when field value is null (clear)", async () => {
    const plugin = freshPlugin();
    await plugin.applyCredentials({ tradovateUsername: null, tradovatePassword: null });

    expect(setTradovateUsername).toHaveBeenCalledWith(null);
    expect(setTradovatePassword).toHaveBeenCalledWith(null);
  });

  it("calls invalidate after writing (resets client + auth state)", async () => {
    const plugin = freshPlugin();
    // Seed a client so invalidate has something to null
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);
    await plugin.initialize();
    expect(plugin.getClient()).not.toBeNull();

    await plugin.applyCredentials({ tradovateUsername: "new-user" });

    expect(plugin.getClient()).toBeNull();
    expect(pluginPrivate(plugin)._everAuthenticated).toBe(false);
  });

  it("auto-generates UUID for tradovateDeviceId when key is absent AND no existing deviceId", async () => {
    vi.mocked(getTradovateDeviceId).mockReturnValue(null);

    const plugin = freshPlugin();
    // tradovateDeviceId is absent from the fields map
    await plugin.applyCredentials({ tradovateUsername: "user" });

    expect(setTradovateDeviceId).toHaveBeenCalledTimes(1);
    const generated = vi.mocked(setTradovateDeviceId).mock.calls[0][0] as string;
    expect(typeof generated).toBe("string");
    expect(generated.length).toBeGreaterThan(0);
    // Should look like a UUID (36 chars with hyphens)
    expect(generated).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("does NOT auto-generate deviceId when one already exists in DB", async () => {
    vi.mocked(getTradovateDeviceId).mockReturnValue("existing-uuid");

    const plugin = freshPlugin();
    // tradovateDeviceId is absent → auto-generate path, but existing value present
    await plugin.applyCredentials({ tradovateUsername: "user" });

    expect(setTradovateDeviceId).not.toHaveBeenCalled();
  });

  it("sets tradovateDeviceId explicitly when key is present in fields", async () => {
    const plugin = freshPlugin();
    await plugin.applyCredentials({ tradovateDeviceId: "explicit-uuid" });

    expect(setTradovateDeviceId).toHaveBeenCalledWith("explicit-uuid");
  });

  it("clears tradovateDeviceId when field value is null", async () => {
    const plugin = freshPlugin();
    await plugin.applyCredentials({ tradovateDeviceId: null });

    expect(setTradovateDeviceId).toHaveBeenCalledWith(null);
  });
});

// ── testConnection ────────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.testConnection", () => {
  it("with valid override fields: authenticates and returns expiresAt + hasMdAccessToken", async () => {
    mockGetTokenExpiresAt.mockReturnValue(1234567890);
    mockGetMdAccessToken.mockReturnValue("md-tok");

    const plugin = freshPlugin();
    const result = await plugin.testConnection({
      tradovateUsername: "u",
      tradovatePassword: "p",
      tradovateApiCid: "c",
      tradovateApiSecret: "s",
      tradovateAppId: "a",
      tradovateAppVersion: "1",
      tradovateDeviceId: "d",
    }) as { expiresAt: number; hasMdAccessToken: boolean };

    expect(result.expiresAt).toBe(1234567890);
    expect(result.hasMdAccessToken).toBe(true);
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockSetTradovateCredsValidatedSignature).toHaveBeenCalledTimes(1);
    expect(mockSetTradovateCredsValidatedAt).toHaveBeenCalledTimes(1);
  });

  it("hasMdAccessToken is false when getMdAccessToken returns null", async () => {
    mockGetMdAccessToken.mockReturnValue(null);

    const plugin = freshPlugin();
    const result = await plugin.testConnection({
      tradovateUsername: "u",
      tradovatePassword: "p",
      tradovateApiCid: "c",
      tradovateApiSecret: "s",
      tradovateAppId: "a",
      tradovateAppVersion: "1",
      tradovateDeviceId: "d",
    }) as { expiresAt: number; hasMdAccessToken: boolean };

    expect(result.hasMdAccessToken).toBe(false);
  });

  it("missing required override field: throws with 'required' in message", async () => {
    const plugin = freshPlugin();
    await expect(
      plugin.testConnection({
        tradovateUsername: "u",
        // tradovatePassword absent
        tradovateApiCid: "c",
        tradovateApiSecret: "s",
        tradovateAppId: "a",
        tradovateAppVersion: "1",
        tradovateDeviceId: "d",
      })
    ).rejects.toThrow("required");

    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockSetTradovateCredsValidatedSignature).not.toHaveBeenCalled();
  });

  it("with no override and missing DB creds: throws 'not configured'", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);

    const plugin = freshPlugin();
    await expect(plugin.testConnection()).rejects.toThrow("not configured");
  });

  it("with no override and DB creds present: authenticates and persists signature", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(VALID_CREDS as never);

    const plugin = freshPlugin();
    const result = await plugin.testConnection() as { expiresAt: number; hasMdAccessToken: boolean };

    expect(result.expiresAt).toBeDefined();
    expect(mockSetTradovateCredsValidatedSignature).toHaveBeenCalledTimes(1);
  });

  it("auth failure: throws and does NOT persist signature", async () => {
    mockAuthenticate.mockRejectedValueOnce(new Error("bad creds"));

    const plugin = freshPlugin();
    await expect(
      plugin.testConnection({
        tradovateUsername: "u",
        tradovatePassword: "p",
        tradovateApiCid: "c",
        tradovateApiSecret: "s",
        tradovateAppId: "a",
        tradovateAppVersion: "1",
        tradovateDeviceId: "d",
      })
    ).rejects.toThrow("bad creds");

    expect(mockSetTradovateCredsValidatedSignature).not.toHaveBeenCalled();
  });
});

// ── classifyError ─────────────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.classifyError", () => {
  it("TradovateAuthPenaltyError → rate_limited", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new TradovateAuthPenaltyError(30))).toBe("rate_limited");
  });

  it("TradovateCaptchaLockoutError → captcha", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new TradovateCaptchaLockoutError("/auth", null))).toBe("captcha");
  });

  it("TradovateCircuitOpenError → circuit_open", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new TradovateCircuitOpenError("/auth", null, Date.now(), 60000))).toBe("circuit_open");
  });

  it("TradovateUnauthorizedError → auth", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new TradovateUnauthorizedError("/auth/accesstokenrequest"))).toBe("auth");
  });

  it("'fetch failed' message → network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("fetch failed: ECONNREFUSED"))).toBe("network");
  });

  it("'timeout' message → network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("request timeout"))).toBe("network");
  });

  it("'aborted' message → network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("aborted"))).toBe("network");
  });

  it("'503' in message → network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("HTTP 503 Service Unavailable"))).toBe("network");
  });

  it("'not configured' message → config_missing", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("Tradovate credentials not configured"))).toBe("config_missing");
  });

  it("'required' message → config_missing", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("tradovatePassword required"))).toBe("config_missing");
  });

  it("unknown error message → auth (default fallback)", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("something completely unknown"))).toBe("auth");
  });

  it("non-Error thrown value → auth fallback", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError("plain string error")).toBe("auth");
  });
});

// ── rejectionProvesTerminal ───────────────────────────────────────────────────

/**
 * The seam the engine's post-flatten bracket cancel reads instead of importing
 * `TradovateOrderRejectionError`. What matters is that it *delegates*: a second
 * copy of the fail-safe rule here would drift from the one `errors.test.ts`
 * pins, and drift in the permissive direction stamps a resting leg terminal.
 */
describe("TradovateBrokerPlugin.rejectionProvesTerminal", () => {
  it("answers with the shipped predicate rather than a restatement of it", () => {
    const plugin = freshPlugin();
    for (const err of [
      new TradovateOrderRejectionError("/order/cancelOrder", 4242, "OrderNotFound", null),
      new TradovateOrderRejectionError("/order/cancelOrder", 4242, "RiskExceeded", null),
      new TradovateOrderRejectionError("/order/cancelOrder", 4242, "OrderNotFound", "account not found"),
      new Error("Tradovate API error 404 on /order/cancelOrder: Not Found"),
      null,
    ]) {
      expect(plugin.rejectionProvesTerminal?.(err)).toBe(isAlreadyTerminalCancelRejection(err));
    }
  });
});

// ── computeCredsSignature ─────────────────────────────────────────────────────

describe("TradovateBrokerPlugin.computeCredsSignature", () => {
  const FIELDS = {
    tradovateUsername: "u",
    tradovatePassword: "p",
    tradovateApiCid: "c",
    tradovateApiSecret: "s",
    tradovateAppId: "a",
    tradovateAppVersion: "1",
    tradovateDeviceId: "d",
  };

  it("returns a non-empty string", () => {
    const sig = freshPlugin().computeCredsSignature(FIELDS);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
  });

  it("same fields produce the same hash (deterministic)", () => {
    const plugin = freshPlugin();
    expect(plugin.computeCredsSignature(FIELDS)).toBe(plugin.computeCredsSignature(FIELDS));
  });

  it("different username produces different hash", () => {
    const plugin = freshPlugin();
    const a = plugin.computeCredsSignature({ ...FIELDS, tradovateUsername: "u1" });
    const b = plugin.computeCredsSignature({ ...FIELDS, tradovateUsername: "u2" });
    expect(a).not.toBe(b);
  });

  it("throws when any required field is missing", () => {
    const plugin = freshPlugin();
    const { tradovatePassword: _omit, ...withoutPassword } = FIELDS;
    expect(() =>
      plugin.computeCredsSignature(withoutPassword as Record<string, string>)
    ).toThrow();
  });
});
