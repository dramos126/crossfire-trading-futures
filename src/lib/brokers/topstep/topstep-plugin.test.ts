import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => { throw new Error("getDb() not available in test"); }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getTopstepApiKey: vi.fn().mockReturnValue(null),
  getTopstepUsername: vi.fn().mockReturnValue(null),
  getTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  setTopstepUsername: vi.fn(),
  setTopstepApiKey: vi.fn(),
}));

const mockResolveTopstepUsername = vi.fn().mockReturnValue(null);
const mockResolveTopstepApiKey = vi.fn().mockReturnValue(null);

vi.mock("@/lib/db/settings-cache", () => ({
  resolveTopstepUsername: (...args: unknown[]) => mockResolveTopstepUsername(...args),
  resolveTopstepApiKey: (...args: unknown[]) => mockResolveTopstepApiKey(...args),
  resolveTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  invalidateSettingsCache: vi.fn(),
  clearCachedToken: vi.fn(),
}));

const mockGetEngineToken = vi.fn().mockResolvedValue("engine-token");
const mockGetToken = vi.fn().mockResolvedValue("browser-token");

vi.mock("@/lib/brokers/topstep/auth", () => ({
  getEngineToken: (...args: unknown[]) => mockGetEngineToken(...args),
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// Track setToken calls per TopstepClient instance
type MockTopstepClientInstance = {
  setToken: ReturnType<typeof vi.fn>;
  getToken: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
  _tokenValue: string | null;
};

const createdMockClients: MockTopstepClientInstance[] = [];

const mockAuthenticate = vi.fn().mockResolvedValue(undefined);

// Spread the original: `classifyError` matches on the real
// `UnauthorizedError` / `AccountNotFoundError` classes, and a bare
// factory turns those into missing-export failures. Only the client
// itself is swapped.
vi.mock("@/lib/brokers/topstep/client", async (importOriginal) => {
  class TopstepClient {
    _tokenValue: string | null = null;
    setToken = vi.fn((token: string) => { this._tokenValue = token; });
    getToken = vi.fn(() => this._tokenValue);
    authenticate = mockAuthenticate;
    constructor() {
      createdMockClients.push(this as unknown as MockTopstepClientInstance);
    }
  }
  return {
    ...(await importOriginal<typeof import("@/lib/brokers/topstep/client")>()),
    TopstepClient,
  };
});

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

vi.mock("@/lib/db/auth", () => ({
  clearCachedToken: vi.fn(),
}));

const mockSetTopstepCredsValidatedSignature = vi.fn();
const mockSetTopstepCredsValidatedAt = vi.fn();

vi.mock("@/lib/db/cred-validation", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/db/cred-validation")>();
  return {
    // Use the real hash function — it has no DB dependency
    computeTopstepCredsSignature: actual.computeTopstepCredsSignature,
    setTopstepCredsValidatedSignature: (...args: unknown[]) => mockSetTopstepCredsValidatedSignature(...args),
    setTopstepCredsValidatedAt: (...args: unknown[]) => mockSetTopstepCredsValidatedAt(...args),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { TopstepBrokerPlugin } from "./index";
import { AccountNotFoundError, TopstepHttpError, TopstepOrderRejectionError } from "./client";
import { getTopstepUsername, getTopstepApiKey, setTopstepUsername, setTopstepApiKey } from "@/lib/db/settings";
import { clearCachedToken } from "@/lib/db/auth";

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshPlugin(): TopstepBrokerPlugin {
  return new TopstepBrokerPlugin();
}

function pluginPrivate(plugin: TopstepBrokerPlugin): Record<string, unknown> {
  return plugin as unknown as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockResolveTopstepUsername.mockReturnValue(null);
  mockResolveTopstepApiKey.mockReturnValue(null);
  mockGetEngineToken.mockReset();
  mockGetEngineToken.mockResolvedValue("engine-token");
  mockGetToken.mockReset();
  mockGetToken.mockResolvedValue("browser-token");
  createdMockClients.length = 0;
  vi.mocked(getTopstepUsername).mockReturnValue(null);
  vi.mocked(getTopstepApiKey).mockReturnValue(null);
  vi.mocked(setTopstepUsername).mockReset();
  vi.mocked(setTopstepApiKey).mockReset();
  vi.mocked(clearCachedToken).mockReset();
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue(undefined);
  mockSetTopstepCredsValidatedSignature.mockReset();
  mockSetTopstepCredsValidatedAt.mockReset();
});

// ── isConfigured ──────────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.isConfigured", () => {
  it("returns false when both username and apiKey are absent", () => {
    mockResolveTopstepUsername.mockReturnValue(null);
    mockResolveTopstepApiKey.mockReturnValue(null);
    expect(freshPlugin().isConfigured()).toBe(false);
  });

  it("returns false when username is present but apiKey is absent", () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue(null);
    expect(freshPlugin().isConfigured()).toBe(false);
  });

  it("returns false when apiKey is present but username is absent", () => {
    mockResolveTopstepUsername.mockReturnValue(null);
    mockResolveTopstepApiKey.mockReturnValue("some-key");
    expect(freshPlugin().isConfigured()).toBe(false);
  });

  it("returns true when both username and apiKey are present", () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");
    expect(freshPlugin().isConfigured()).toBe(true);
  });
});

// ── isExpected ────────────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.isExpected", () => {
  it("returns false when no credentials are present", () => {
    // Was a hardcoded `true` on the reasoning that Topstep is *the*
    // broker. A Tradovate-only install is a supported shape now, and an
    // unconfigured broker declaring itself expected is what the boot loop
    // reads to decide whether to initialize it.
    mockResolveTopstepUsername.mockReturnValue(null);
    mockResolveTopstepApiKey.mockReturnValue(null);
    expect(freshPlugin().isExpected()).toBe(false);
  });

  it("returns false on a half-populated credential pair", () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue(null);
    expect(freshPlugin().isExpected()).toBe(false);
  });

  it("returns true when credentials are present", () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");
    expect(freshPlugin().isExpected()).toBe(true);
  });
});

// ── initialize — no credentials ───────────────────────────────────────────────

describe("TopstepBrokerPlugin.initialize — no credentials", () => {
  it("getClient returns null after initialize when isConfigured is false", async () => {
    // Both resolvers return null → isConfigured() = false
    mockResolveTopstepUsername.mockReturnValue(null);
    mockResolveTopstepApiKey.mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(plugin.getClient()).toBeNull();
  });

  it("getEngineToken is not called when isConfigured is false", async () => {
    mockResolveTopstepUsername.mockReturnValue(null);
    mockResolveTopstepApiKey.mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(mockGetEngineToken).not.toHaveBeenCalled();
  });
});

// ── initialize — happy path ───────────────────────────────────────────────────

describe("TopstepBrokerPlugin.initialize — happy path", () => {
  it("getClient returns a TopstepClient instance after successful initialize", async () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");

    const plugin = freshPlugin();
    await plugin.initialize();

    expect(plugin.getClient()).not.toBeNull();
    // Exactly one client constructed
    expect(createdMockClients).toHaveLength(1);
  });

  it("sets the engine token on the client during initialize", async () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");
    mockGetEngineToken.mockResolvedValue("engine-token-abc");

    const plugin = freshPlugin();
    await plugin.initialize();

    const client = createdMockClients[0];
    expect(client.setToken).toHaveBeenCalledWith("engine-token-abc");
  });

  it("calling initialize twice reuses the same client instance (no re-construction)", async () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");

    const plugin = freshPlugin();
    await plugin.initialize();
    const firstClient = plugin.getClient();
    await plugin.initialize();
    const secondClient = plugin.getClient();

    expect(secondClient).toBe(firstClient);
    // Only one TopstepClient was ever constructed
    expect(createdMockClients).toHaveLength(1);
    // setToken was called twice — once per initialize
    expect(createdMockClients[0].setToken).toHaveBeenCalledTimes(2);
  });
});

// ── invalidate ────────────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.invalidate", () => {
  it("clears the token on the client by calling setToken with empty string", async () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");

    const plugin = freshPlugin();
    await plugin.initialize();
    const client = createdMockClients[0];

    plugin.invalidate();

    expect(client.setToken).toHaveBeenLastCalledWith("");
  });

  it("does not throw when called before initialize (client is null)", () => {
    const plugin = freshPlugin();
    // _client is null at construction; invalidate uses optional chaining
    expect(() => plugin.invalidate()).not.toThrow();
  });

  it("getClient still returns the client instance after invalidate (only token is cleared, not the client)", async () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");

    const plugin = freshPlugin();
    await plugin.initialize();
    const clientBeforeInvalidate = plugin.getClient();

    plugin.invalidate();

    // Topstep invalidate only clears the token — client instance survives
    // so per-request token refresh in engine-singleton can swap back in
    // a new token without rebuilding the client.
    expect(plugin.getClient()).toBe(clientBeforeInvalidate);
    expect(pluginPrivate(plugin)._client).not.toBeNull();
  });
});

// ── getBrowserToken ───────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.getBrowserToken", () => {
  it("returns null when isConfigured is false", async () => {
    mockResolveTopstepUsername.mockReturnValue(null);
    mockResolveTopstepApiKey.mockReturnValue(null);

    const plugin = freshPlugin();
    const token = await plugin.getBrowserToken();

    expect(token).toBeNull();
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("delegates to getToken when isConfigured is true", async () => {
    mockResolveTopstepUsername.mockReturnValue("user@example.com");
    mockResolveTopstepApiKey.mockReturnValue("some-key");
    mockGetToken.mockResolvedValue("browser-token-xyz");

    const plugin = freshPlugin();
    const token = await plugin.getBrowserToken();

    expect(token).toBe("browser-token-xyz");
    expect(mockGetToken).toHaveBeenCalledTimes(1);
  });
});

// ── credentialSchema ──────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.credentialSchema", () => {
  it("returns exactly 2 fields", () => {
    const schema = freshPlugin().credentialSchema();
    expect(schema).toHaveLength(2);
  });

  it("field keys are topstepUsername and topstepApiKey", () => {
    const schema = freshPlugin().credentialSchema();
    const keys = schema.map((f) => f.key);
    expect(keys).toContain("topstepUsername");
    expect(keys).toContain("topstepApiKey");
  });

  it("topstepApiKey has secret: true", () => {
    const schema = freshPlugin().credentialSchema();
    const apiKeyField = schema.find((f) => f.key === "topstepApiKey")!;
    expect(apiKeyField.secret).toBe(true);
  });

  it("topstepUsername has secret: false", () => {
    const schema = freshPlugin().credentialSchema();
    const usernameField = schema.find((f) => f.key === "topstepUsername")!;
    expect(usernameField.secret).toBe(false);
  });
});

// ── applyCredentials ──────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.applyCredentials", () => {
  it("calls setTopstepUsername when a new non-empty username is provided", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue(null);
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.applyCredentials({ topstepUsername: "newuser" });

    expect(setTopstepUsername).toHaveBeenCalledWith("newuser");
  });

  it("calls setTopstepApiKey when a new non-empty apiKey is provided", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue(null);
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.applyCredentials({ topstepApiKey: "new-key" });

    expect(setTopstepApiKey).toHaveBeenCalledWith("new-key");
  });

  it("skips setTopstepUsername when key is absent from fields", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue("existing");
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.applyCredentials({ topstepApiKey: "new-key" });

    expect(setTopstepUsername).not.toHaveBeenCalled();
  });

  it("calls setTopstepUsername with null when field value is null (clear)", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue("existing");
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.applyCredentials({ topstepUsername: null });

    expect(setTopstepUsername).toHaveBeenCalledWith(null);
  });

  it("calls setTopstepApiKey with null when field value is null (clear)", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue(null);
    vi.mocked(getTopstepApiKey).mockReturnValue("existing-key");

    const plugin = freshPlugin();
    await plugin.applyCredentials({ topstepApiKey: null });

    expect(setTopstepApiKey).toHaveBeenCalledWith(null);
  });

  it("calls clearCachedToken after a credential change", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue(null);
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.applyCredentials({ topstepUsername: "newuser" });

    expect(clearCachedToken).toHaveBeenCalledTimes(1);
  });

  it("does NOT call clearCachedToken when no field changes (same value as current)", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue("same-user");
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    // Providing the same value that's already stored → no-op path
    await plugin.applyCredentials({ topstepUsername: "same-user" });

    expect(clearCachedToken).not.toHaveBeenCalled();
    expect(setTopstepUsername).not.toHaveBeenCalled();
  });

  it("calls invalidate (setToken with empty string) on the client after a credential change", async () => {
    mockResolveTopstepUsername.mockReturnValue("user");
    mockResolveTopstepApiKey.mockReturnValue("key");
    vi.mocked(getTopstepUsername).mockReturnValue(null);
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await plugin.initialize();
    const client = createdMockClients[0];
    const callsBefore = client.setToken.mock.calls.length;

    await plugin.applyCredentials({ topstepUsername: "newuser" });

    // invalidate() calls client.setToken("") exactly once more
    expect(client.setToken.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(client.setToken).toHaveBeenLastCalledWith("");
  });
});

// ── testConnection ────────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.testConnection", () => {
  it("with valid override fields: calls authenticate and persists signature + returns undefined", async () => {
    const plugin = freshPlugin();
    const result = await plugin.testConnection({
      topstepUsername: "user@example.com",
      topstepApiKey: "valid-key",
    });

    expect(result).toBeUndefined();
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockSetTopstepCredsValidatedSignature).toHaveBeenCalledTimes(1);
    expect(mockSetTopstepCredsValidatedAt).toHaveBeenCalledTimes(1);
  });

  it("with valid override fields: passes username and apiKey to the client (a new TopstepClient is created)", async () => {
    const plugin = freshPlugin();
    await plugin.testConnection({
      topstepUsername: "user@example.com",
      topstepApiKey: "valid-key",
    });
    // testConnection always creates its own TopstepClient — never reuses the engine client
    expect(createdMockClients.length).toBeGreaterThanOrEqual(1);
  });

  it("with empty topstepUsername in override: throws 'required' before auth attempt", async () => {
    const plugin = freshPlugin();
    await expect(
      plugin.testConnection({ topstepUsername: "", topstepApiKey: "key" })
    ).rejects.toThrow("topstepUsername required");
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it("with missing topstepUsername in override: throws 'required'", async () => {
    const plugin = freshPlugin();
    await expect(
      plugin.testConnection({ topstepApiKey: "key" })
    ).rejects.toThrow("topstepUsername required");
  });

  it("with missing topstepApiKey in override: throws 'required'", async () => {
    const plugin = freshPlugin();
    await expect(
      plugin.testConnection({ topstepUsername: "user" })
    ).rejects.toThrow("topstepApiKey required");
  });

  it("with no override and missing DB creds: throws 'not configured'", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue(null);
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await expect(plugin.testConnection()).rejects.toThrow("not configured");
  });

  it("with no override and partial DB creds (username only): throws 'not configured'", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue("user");
    vi.mocked(getTopstepApiKey).mockReturnValue(null);

    const plugin = freshPlugin();
    await expect(plugin.testConnection()).rejects.toThrow("not configured");
  });

  it("with no override and DB creds present: authenticates and persists signature", async () => {
    vi.mocked(getTopstepUsername).mockReturnValue("db-user");
    vi.mocked(getTopstepApiKey).mockReturnValue("db-key");

    const plugin = freshPlugin();
    const result = await plugin.testConnection();

    expect(result).toBeUndefined();
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockSetTopstepCredsValidatedSignature).toHaveBeenCalledTimes(1);
  });

  it("auth failure: throws the error (classifyError maps it to auth)", async () => {
    mockAuthenticate.mockRejectedValueOnce(new Error("invalid credentials"));

    const plugin = freshPlugin();
    await expect(
      plugin.testConnection({ topstepUsername: "user", topstepApiKey: "bad-key" })
    ).rejects.toThrow("invalid credentials");

    // Signature must NOT be written on failure
    expect(mockSetTopstepCredsValidatedSignature).not.toHaveBeenCalled();
  });
});

// ── classifyError ─────────────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.classifyError", () => {
  it("classifies 'fetch failed' message as network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("fetch failed: connection refused"))).toBe("network");
  });

  it("classifies 'timeout' message as network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("request timeout"))).toBe("network");
  });

  it("classifies 'aborted' message as network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("operation aborted"))).toBe("network");
  });

  it("classifies 503 HTTP status in message as network", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("server returned 503"))).toBe("network");
  });

  it("classifies 'not configured' message as config_missing", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("Topstep credentials not configured"))).toBe("config_missing");
  });

  it("classifies 'required' message as config_missing", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("topstepUsername required"))).toBe("config_missing");
  });

  it("classifies 'missing topstep_username' as config_missing", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("missing topstep_username env var"))).toBe("config_missing");
  });

  it("classifies unknown error as auth (default fallback)", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError(new Error("invalid credentials"))).toBe("auth");
  });

  it("classifies non-Error thrown value as auth", () => {
    const plugin = freshPlugin();
    expect(plugin.classifyError("some string error")).toBe("auth");
  });
});

// ── computeCredsSignature ─────────────────────────────────────────────────────

describe("TopstepBrokerPlugin.computeCredsSignature", () => {
  it("returns a non-empty string", () => {
    const plugin = freshPlugin();
    const sig = plugin.computeCredsSignature({ topstepUsername: "u", topstepApiKey: "k" });
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
  });

  it("same fields produce the same hash (deterministic)", () => {
    const plugin = freshPlugin();
    const a = plugin.computeCredsSignature({ topstepUsername: "u", topstepApiKey: "k" });
    const b = plugin.computeCredsSignature({ topstepUsername: "u", topstepApiKey: "k" });
    expect(a).toBe(b);
  });

  it("different fields produce different hashes", () => {
    const plugin = freshPlugin();
    const a = plugin.computeCredsSignature({ topstepUsername: "u1", topstepApiKey: "k" });
    const b = plugin.computeCredsSignature({ topstepUsername: "u2", topstepApiKey: "k" });
    expect(a).not.toBe(b);
  });

  it("throws when topstepUsername is missing", () => {
    const plugin = freshPlugin();
    expect(() =>
      plugin.computeCredsSignature({ topstepApiKey: "k" } as Record<string, string>)
    ).toThrow();
  });

  it("throws when topstepApiKey is missing", () => {
    const plugin = freshPlugin();
    expect(() =>
      plugin.computeCredsSignature({ topstepUsername: "u" } as Record<string, string>)
    ).toThrow();
  });
});

// ── ownsError / classifyError — place refusals (A120) ─────────────────────────

// The engine's rejection-triggered status check and `maybeOrphanFromBrokerError`
// both ask `ownsError` first and `classifyError` second; an unowned error is
// no answer. The check runs only on `order_rejected` / `account_unavailable`.
describe("TopstepBrokerPlugin — place refusals", () => {
  it.each([2, 3, 4, 10])("owns risk-rule code %i and classifies it as the broker's refusal", (code) => {
    const plugin = freshPlugin();
    const err = new TopstepOrderRejectionError(42, code, "Daily loss limit reached");
    expect(plugin.ownsError(err)).toBe(true);
    expect(plugin.classifyError(err)).toBe("order_rejected");
  });

  // Matched by class ahead of the message heuristics: gateway text that reads
  // like a credential problem must not reach the `auth` catch-all, which on
  // Topstep stops the engine.
  it("classifies a refusal by its type, not by text that reads like auth", () => {
    const err = new TopstepOrderRejectionError(42, 10, "Account is not authorized to trade");
    expect(freshPlugin().classifyError(err)).toBe("order_rejected");
  });

  it("does not own a 429 or a network error, so neither is a refusal", () => {
    const plugin = freshPlugin();
    // The exact shapes `TopstepClient.post` and Node's fetch throw.
    const rateLimited = new TopstepHttpError(429, "Topstep API error 429 on /api/Order/place: (empty body) | payload={}");
    const network = new TypeError("fetch failed");
    expect(plugin.ownsError(rateLimited)).toBe(false);
    expect(plugin.ownsError(network)).toBe(false);
  });

  it("keeps AccountNotFound account_unavailable", () => {
    const plugin = freshPlugin();
    const err = new AccountNotFoundError(42);
    expect(plugin.ownsError(err)).toBe(true);
    expect(plugin.classifyError(err)).toBe("account_unavailable");
  });
});
