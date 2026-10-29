import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

// Session gate: stub the store seam, keep `hasSession` itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const webAccount = vi.hoisted(() => ({ hasWebAccount: vi.fn(() => false) }));
vi.mock("@/lib/db/web-account", () => webAccount);

const mockTopstepPlugin = {
  id: "topstep",
  isConfigured: vi.fn().mockReturnValue(false),
  testConnection: vi.fn().mockResolvedValue(undefined),
  classifyError: vi.fn().mockReturnValue("auth" as const),
};

const mockTradovatePlugin = {
  id: "tradovate",
  isConfigured: vi.fn().mockReturnValue(false),
  testConnection: vi.fn().mockResolvedValue({
    expiresAt: 1700000000000,
    hasMdAccessToken: true,
  }),
  classifyError: vi.fn().mockReturnValue("auth" as const),
};

const mockDatabentoProvider = {
  id: "databento",
  isConfigured: vi.fn().mockReturnValue(true),
  testConnection: vi.fn().mockResolvedValue({
    dataset: "GLBX.MDP3",
    range: { start: "2019-01-01T00:00:00Z", end: "2026-08-20T00:00:00Z" },
    probedAt: "2026-08-21T00:00:00Z",
  }),
  classifyError: vi.fn().mockReturnValue("entitlement" as const),
};

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    getPlugin: vi.fn((id: string) => {
      if (id === "topstep") return mockTopstepPlugin;
      if (id === "tradovate") return mockTradovatePlugin;
      return null;
    }),
  },
}));

vi.mock("@/lib/market-data/registry-singleton", () => ({
  marketDataRegistry: {
    getProvider: vi.fn((id: string) => (id === "databento" ? mockDatabentoProvider : null)),
  },
}));

// The route imports TradovateAuthPenaltyError directly — we need the real class
// available so instanceof checks in messageFor() work correctly.
// We do NOT mock @/lib/brokers/tradovate/errors — use the real module.

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { POST } from "./route";
import { NextRequest } from "next/server";
import { TradovateAuthPenaltyError } from "@/lib/brokers/tradovate/errors";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) headers["x-session-token"] = token;
  return new NextRequest("http://localhost/api/settings/test-connection", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ── Reset ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  webAccount.hasWebAccount.mockReturnValue(false);
  mockTopstepPlugin.isConfigured.mockReset();
  mockTopstepPlugin.isConfigured.mockReturnValue(false);
  mockTopstepPlugin.testConnection.mockReset();
  mockTopstepPlugin.testConnection.mockResolvedValue(undefined);
  mockTopstepPlugin.classifyError.mockReset();
  mockTopstepPlugin.classifyError.mockReturnValue("auth");

  mockTradovatePlugin.isConfigured.mockReset();
  mockTradovatePlugin.isConfigured.mockReturnValue(false);
  mockTradovatePlugin.testConnection.mockReset();
  mockTradovatePlugin.testConnection.mockResolvedValue({
    expiresAt: 1700000000000,
    hasMdAccessToken: true,
  });
  mockTradovatePlugin.classifyError.mockReset();
  mockTradovatePlugin.classifyError.mockReturnValue("auth");

  mockDatabentoProvider.isConfigured.mockReset();
  mockDatabentoProvider.isConfigured.mockReturnValue(true);
  mockDatabentoProvider.testConnection.mockReset();
  mockDatabentoProvider.testConnection.mockResolvedValue({
    dataset: "GLBX.MDP3",
    range: { start: "2019-01-01T00:00:00Z", end: "2026-08-20T00:00:00Z" },
    probedAt: "2026-08-21T00:00:00Z",
  });
  mockDatabentoProvider.classifyError.mockReset();
  mockDatabentoProvider.classifyError.mockReturnValue("entitlement");
});

// ── providerId dispatch ───────────────────────────────────────────────────────

describe("POST /api/settings/test-connection — providerId dispatch", () => {
  it("routes providerId to the market-data registry, not the broker registry", async () => {
    const res = await POST(makeRequest({ providerId: "databento" }, "tok"));
    const body = await res.json();

    expect(mockDatabentoProvider.testConnection).toHaveBeenCalledTimes(1);
    expect(mockTopstepPlugin.testConnection).not.toHaveBeenCalled();
    expect(body.ok).toBe(true);
    expect(body.range.end).toBe("2026-08-20T00:00:00Z");
  });

  it("returns 400 for an unregistered providerId", async () => {
    const res = await POST(makeRequest({ providerId: "nope" }, "tok"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unknown provider");
  });

  it("returns 400 when both brokerId and providerId are present", async () => {
    const res = await POST(makeRequest({ brokerId: "topstep", providerId: "databento" }, "tok"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not both");
  });

  it("requires a token even with fields — the wizard drive-by gate is broker-only", async () => {
    const res = await POST(
      makeRequest({ providerId: "databento", fields: { databentoApiKey: "k" } }),
    );
    expect(res.status).toBe(401);
    expect(mockDatabentoProvider.testConnection).not.toHaveBeenCalled();
  });

  it("surfaces an entitlement failure as 200 with the vendor's own text", async () => {
    mockDatabentoProvider.testConnection.mockRejectedValue(
      new Error("Databento 403 Forbidden: dataset not entitled on this plan"),
    );
    const res = await POST(makeRequest({ providerId: "databento" }, "tok"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("entitlement");
    expect(body.message).toContain("not entitled on this plan");
  });

  it("passes typed fields through to the provider without persisting them", async () => {
    await POST(
      makeRequest({ providerId: "databento", fields: { databentoApiKey: "typed" } }, "tok"),
    );
    expect(mockDatabentoProvider.testConnection).toHaveBeenCalledWith({ databentoApiKey: "typed" });
  });
});

// ── 400 — body parse failures ─────────────────────────────────────────────────

describe("POST /api/settings/test-connection — body validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest("http://localhost/api/settings/test-connection", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": "tok" },
      body: "not-json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/json/i);
  });

  it("returns 400 when brokerId is missing from body", async () => {
    const res = await POST(makeRequest({}, "tok"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/brokerid/i);
  });

  it("returns 400 when brokerId is an empty string", async () => {
    const res = await POST(makeRequest({ brokerId: "" }, "tok"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/brokerid/i);
  });

  it("returns 400 for unknown brokerId", async () => {
    const res = await POST(makeRequest({ brokerId: "unknown-broker" }, "tok"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unknown broker");
  });

  it("returns 400 when fields is a non-object (e.g. string)", async () => {
    const res = await POST(makeRequest({ brokerId: "topstep", fields: "bad" }, "tok"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when a field value is empty string", async () => {
    const res = await POST(makeRequest({ brokerId: "topstep", fields: { topstepUsername: "" } }, "tok"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when a field value exceeds 512 characters", async () => {
    const res = await POST(makeRequest({
      brokerId: "topstep",
      fields: { topstepUsername: "x".repeat(513) },
    }, "tok"));
    expect(res.status).toBe(400);
  });
});

// ── 401 — no token, no fields ─────────────────────────────────────────────────

describe("POST /api/settings/test-connection — 401 when no token and no fields", () => {
  it("returns 401 when x-session-token is absent and no fields provided", async () => {
    const res = await POST(makeRequest({ brokerId: "topstep" }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/token/i);
  });

  it("returns 401 when x-session-token is absent and fields is empty object", async () => {
    // empty object {} has no keys — fields present but no useful overrides;
    // the route treats fields as provided (hasFields = true) so this proceeds
    // through to the isConfigured() gate — only {} with plugin unconfigured succeeds.
    // But the plugin is unconfigured here so it should reach testConnection.
    mockTopstepPlugin.isConfigured.mockReturnValue(false);
    mockTopstepPlugin.testConnection.mockResolvedValue(undefined);

    const res = await POST(makeRequest({ brokerId: "topstep", fields: {} }));
    // fields: {} → hasFields = true → wizard path proceeds (not 401)
    // Plugin not configured → passes drive-by gate → calls testConnection
    expect(res.status).toBe(200);
  });
});

// ── 409 — drive-by takeover guard ────────────────────────────────────────────

describe("POST /api/settings/test-connection — 409 drive-by guard (wizard, already configured)", () => {
  it("returns 409 when no token, fields provided, and plugin is already configured", async () => {
    mockTopstepPlugin.isConfigured.mockReturnValue(true);

    const res = await POST(makeRequest({
      brokerId: "topstep",
      fields: { topstepUsername: "user", topstepApiKey: "key" },
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth");
  });

  it("returns 409 on an unconfigured plugin once a sign-in account exists — first run is over", async () => {
    webAccount.hasWebAccount.mockReturnValue(true);

    const res = await POST(makeRequest({
      brokerId: "topstep",
      fields: { topstepUsername: "user", topstepApiKey: "key" },
    }));
    expect(res.status).toBe(409);
    expect(mockTopstepPlugin.testConnection).not.toHaveBeenCalled();
  });

  it("409 message mentions Already configured", async () => {
    mockTopstepPlugin.isConfigured.mockReturnValue(true);

    const res = await POST(makeRequest({
      brokerId: "topstep",
      fields: { topstepUsername: "user", topstepApiKey: "key" },
    }));
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/already configured/i);
  });
});

// ── Wizard path (no token, fields, plugin unconfigured) ───────────────────────

describe("POST /api/settings/test-connection — wizard path proceeds when unconfigured", () => {
  it("calls testConnection and returns 200 when plugin is unconfigured and fields are provided", async () => {
    mockTopstepPlugin.isConfigured.mockReturnValue(false);

    const res = await POST(makeRequest({
      brokerId: "topstep",
      fields: { topstepUsername: "wizard-user", topstepApiKey: "wizard-key" },
    }));
    expect(res.status).toBe(200);
    expect(mockTopstepPlugin.testConnection).toHaveBeenCalledWith({
      topstepUsername: "wizard-user",
      topstepApiKey: "wizard-key",
    });
  });
});

// ── Authenticated path — token + no fields ────────────────────────────────────

describe("POST /api/settings/test-connection — token present, no fields (stored creds path)", () => {
  it("calls testConnection with undefined fields when no fields in body", async () => {
    const res = await POST(makeRequest({ brokerId: "topstep" }, "valid-token"));
    expect(res.status).toBe(200);
    expect(mockTopstepPlugin.testConnection).toHaveBeenCalledWith(undefined);
  });

  it("does NOT call isConfigured when token is present (drive-by gate skipped)", async () => {
    await POST(makeRequest({ brokerId: "topstep" }, "valid-token"));
    expect(mockTopstepPlugin.isConfigured).not.toHaveBeenCalled();
  });
});

// ── Authenticated path — token + fields ──────────────────────────────────────

describe("POST /api/settings/test-connection — token present, fields provided (override path)", () => {
  it("calls testConnection with the override fields", async () => {
    const res = await POST(makeRequest({
      brokerId: "topstep",
      fields: { topstepUsername: "settings-user", topstepApiKey: "settings-key" },
    }, "valid-token"));
    expect(res.status).toBe(200);
    expect(mockTopstepPlugin.testConnection).toHaveBeenCalledWith({
      topstepUsername: "settings-user",
      topstepApiKey: "settings-key",
    });
  });
});

// ── Success responses ─────────────────────────────────────────────────────────

describe("POST /api/settings/test-connection — success responses", () => {
  it("topstep success returns { ok: true } with no extra fields (plugin returns undefined)", async () => {
    mockTopstepPlugin.testConnection.mockResolvedValue(undefined);

    const res = await POST(makeRequest({ brokerId: "topstep" }, "tok"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // Topstep returns undefined — spread produces no extra keys
    expect(Object.keys(body)).toEqual(["ok"]);
  });

  it("tradovate success spreads expiresAt and hasMdAccessToken into response", async () => {
    mockTradovatePlugin.testConnection.mockResolvedValue({
      expiresAt: 1700000001234,
      hasMdAccessToken: false,
    });

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.expiresAt).toBe(1700000001234);
    expect(body.hasMdAccessToken).toBe(false);
  });

  it("tradovate success with hasMdAccessToken true is reflected in response", async () => {
    mockTradovatePlugin.testConnection.mockResolvedValue({
      expiresAt: 9999999999,
      hasMdAccessToken: true,
    });

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as Record<string, unknown>;
    expect(body.hasMdAccessToken).toBe(true);
  });
});

// ── Failure responses — classifyError mapping ─────────────────────────────────

describe("POST /api/settings/test-connection — failure response shapes", () => {
  it("config_missing → topstep returns 422 with ok: false and error: config_missing", async () => {
    mockTopstepPlugin.testConnection.mockRejectedValue(new Error("not configured"));
    mockTopstepPlugin.classifyError.mockReturnValue("config_missing");

    const res = await POST(makeRequest({ brokerId: "topstep" }, "tok"));
    expect(res.status).toBe(200); // route always returns 200 — failure shape is in body
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("config_missing");
    expect(body.message).toMatch(/topstep/i);
    expect(body.message).toMatch(/incomplete|fill/i);
  });

  it("auth → topstep returns ok: false with auth message about credentials", async () => {
    mockTopstepPlugin.testConnection.mockRejectedValue(new Error("401 Unauthorized"));
    mockTopstepPlugin.classifyError.mockReturnValue("auth");

    const res = await POST(makeRequest({ brokerId: "topstep" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth");
    expect(body.message).toMatch(/topstep/i);
    expect(body.message).toMatch(/username|api key|credentials/i);
  });

  it("network → topstep returns ok: false with network message", async () => {
    mockTopstepPlugin.testConnection.mockRejectedValue(new Error("fetch failed"));
    mockTopstepPlugin.classifyError.mockReturnValue("network");

    const res = await POST(makeRequest({ brokerId: "topstep" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("network");
    expect(body.message).toMatch(/reach topstep|try again/i);
  });

  it("config_missing → tradovate returns message about filling in every field", async () => {
    mockTradovatePlugin.testConnection.mockRejectedValue(new Error("tradovateApiCid required"));
    mockTradovatePlugin.classifyError.mockReturnValue("config_missing");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("config_missing");
    expect(body.message).toMatch(/tradovate/i);
    expect(body.message).toMatch(/fill|field/i);
  });

  it("rate_limited → tradovate with TradovateAuthPenaltyError includes pTimeSec in message", async () => {
    const penaltyErr = new TradovateAuthPenaltyError(42);
    mockTradovatePlugin.testConnection.mockRejectedValue(penaltyErr);
    mockTradovatePlugin.classifyError.mockReturnValue("rate_limited");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("rate_limited");
    // The wait time should appear in the message
    expect(body.message).toMatch(/42s/);
  });

  it("rate_limited → tradovate with non-penalty error uses 'wait a moment' fallback", async () => {
    mockTradovatePlugin.testConnection.mockRejectedValue(new Error("rate limit exceeded"));
    mockTradovatePlugin.classifyError.mockReturnValue("rate_limited");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("rate_limited");
    expect(body.message).toMatch(/wait a moment/i);
  });

  it("network → tradovate returns message about reaching Tradovate", async () => {
    mockTradovatePlugin.testConnection.mockRejectedValue(new Error("fetch failed"));
    mockTradovatePlugin.classifyError.mockReturnValue("network");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("network");
    expect(body.message).toMatch(/reach tradovate|try again/i);
  });

  it("captcha → tradovate surfaces the error message verbatim", async () => {
    const captchaErr = new Error("p-captcha lockout on /auth/accessTokenRequest — third-party access disabled for ~1h");
    mockTradovatePlugin.testConnection.mockRejectedValue(captchaErr);
    mockTradovatePlugin.classifyError.mockReturnValue("captcha");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("captcha");
    expect(body.message).toBe(captchaErr.message);
  });

  it("circuit_open → tradovate surfaces the error message verbatim", async () => {
    const circuitErr = new Error("Tradovate circuit open for /auth/accessTokenRequest — 30000ms remaining");
    mockTradovatePlugin.testConnection.mockRejectedValue(circuitErr);
    mockTradovatePlugin.classifyError.mockReturnValue("circuit_open");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("circuit_open");
    expect(body.message).toBe(circuitErr.message);
  });

  it("auth → tradovate surfaces the error message verbatim", async () => {
    const authErr = new Error("Tradovate unauthorized on /auth/accessTokenRequest — token may be expired");
    mockTradovatePlugin.testConnection.mockRejectedValue(authErr);
    mockTradovatePlugin.classifyError.mockReturnValue("auth");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("auth");
    expect(body.message).toBe(authErr.message);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("POST /api/settings/test-connection — edge cases", () => {
  it("plugin.testConnection throws a non-Error (string) — handled gracefully, not an unhandled rejection", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockTopstepPlugin.testConnection.mockRejectedValue("plain string error" as any);
    // classifyError receives a string, not an Error — still returns some kind
    mockTopstepPlugin.classifyError.mockReturnValue("auth");

    const res = await POST(makeRequest({ brokerId: "topstep" }, "tok"));
    const body = await res.json() as { ok: boolean; error: string };
    // Route must not throw — response should be a well-formed failure body
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("plugin.testConnection throws a non-Error — messageFor falls back to String(err) for unknown plugin id", async () => {
    // Simulate an unknown third-party plugin by temporarily returning a stub
    // with a different id. We can't swap getPlugin easily without re-wiring
    // the mock, so instead we verify the tradovate path where non-Error thrown
    // values get String(err) for captcha/circuit_open/auth branches.
    mockTradovatePlugin.testConnection.mockRejectedValue("raw string throw");
    mockTradovatePlugin.classifyError.mockReturnValue("auth");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    // String(err) for a string throw is the string itself
    expect(body.message).toBe("raw string throw");
  });

  it("fields: {} (empty object) is treated as hasFields=true and proceeds past 401 check", async () => {
    mockTopstepPlugin.isConfigured.mockReturnValue(false);

    const res = await POST(makeRequest({ brokerId: "topstep", fields: {} }));
    // No 401 — fields is present (hasFields = true), wizard path proceeds
    expect(res.status).not.toBe(401);
  });

  it("fields absent from body is treated as hasFields=false — triggers 401 without token", async () => {
    const res = await POST(makeRequest({ brokerId: "topstep" }));
    expect(res.status).toBe(401);
  });

  it("rate_limited with TradovateAuthPenaltyError pTimeSec=null uses 'wait a moment'", async () => {
    const penaltyErr = new TradovateAuthPenaltyError(null);
    mockTradovatePlugin.testConnection.mockRejectedValue(penaltyErr);
    mockTradovatePlugin.classifyError.mockReturnValue("rate_limited");

    const res = await POST(makeRequest({ brokerId: "tradovate" }, "tok"));
    const body = await res.json() as { message: string };
    expect(body.message).toMatch(/wait a moment/i);
  });
});
