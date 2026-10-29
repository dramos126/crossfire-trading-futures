import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockPlugin1 = {
  id: "topstep",
  displayName: "Topstep",
  isConfigured: vi.fn().mockReturnValue(true),
  credentialSchema: vi.fn().mockReturnValue([
    { key: "topstepUsername", label: "Username", secret: false, required: true },
    { key: "topstepApiKey", label: "API Key", secret: true, required: true },
  ]),
};

const mockPlugin2 = {
  id: "tradovate",
  displayName: "Tradovate",
  isConfigured: vi.fn().mockReturnValue(false),
  credentialSchema: vi.fn().mockReturnValue([
    { key: "tradovateUsername", label: "Username", secret: false, required: true },
    { key: "tradovatePassword", label: "Password", secret: true, required: true },
  ]),
};

vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    allPlugins: vi.fn(() => [mockPlugin1, mockPlugin2]),
  },
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { GET } from "./route";
import { NextRequest } from "next/server";
import { validateSession } from "@/lib/db/auth";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["x-session-token"] = token;
  return new NextRequest("http://localhost/api/settings/schemas", { headers });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPlugin1.isConfigured.mockReturnValue(true);
  mockPlugin2.isConfigured.mockReturnValue(false);
  vi.mocked(validateSession).mockReturnValue(true);
});

describe("GET /api/settings/schemas", () => {
  it("returns 401 when x-session-token header is missing", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 200 when x-session-token header is present", async () => {
    const response = await GET(makeRequest("some-valid-token"));
    expect(response.status).toBe(200);
  });

  it("response body is an array", async () => {
    const response = await GET(makeRequest("tok"));
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("each schema entry has id, displayName, isConfigured, and fields keys", async () => {
    const response = await GET(makeRequest("tok"));
    const body = await response.json() as Array<Record<string, unknown>>;
    for (const schema of body) {
      expect(schema).toHaveProperty("id");
      expect(schema).toHaveProperty("displayName");
      expect(schema).toHaveProperty("isConfigured");
      expect(schema).toHaveProperty("fields");
    }
  });

  it("fields is an array of CredentialField objects with key, label, secret, required", async () => {
    const response = await GET(makeRequest("tok"));
    const body = await response.json() as Array<{ fields: Array<Record<string, unknown>> }>;
    for (const schema of body) {
      expect(Array.isArray(schema.fields)).toBe(true);
      for (const field of schema.fields) {
        expect(field).toHaveProperty("key");
        expect(field).toHaveProperty("label");
        expect(field).toHaveProperty("secret");
        expect(field).toHaveProperty("required");
      }
    }
  });

  it("returns one entry per registered plugin", async () => {
    const response = await GET(makeRequest("tok"));
    const body = await response.json() as unknown[];
    expect(body).toHaveLength(2);
  });

  it("isConfigured reflects each plugin's configured state", async () => {
    mockPlugin1.isConfigured.mockReturnValue(true);
    mockPlugin2.isConfigured.mockReturnValue(false);

    const response = await GET(makeRequest("tok"));
    const body = await response.json() as Array<{ id: string; isConfigured: boolean }>;
    const topstep = body.find((s) => s.id === "topstep")!;
    const tradovate = body.find((s) => s.id === "tradovate")!;

    expect(topstep.isConfigured).toBe(true);
    expect(tradovate.isConfigured).toBe(false);
  });

  it("id and displayName match plugin registration values", async () => {
    const response = await GET(makeRequest("tok"));
    const body = await response.json() as Array<{ id: string; displayName: string }>;
    const topstep = body.find((s) => s.id === "topstep")!;
    expect(topstep.displayName).toBe("Topstep");
  });

  it("returns 401 when the token is present but not a live session", async () => {
    // The gate this replaced checked presence only, so any non-empty
    // string authenticated every route in the app. It validates now.
    vi.mocked(validateSession).mockReturnValue(false);
    const response = await GET(makeRequest("x"));
    expect(response.status).toBe(401);
    expect(validateSession).toHaveBeenCalledWith("x");
  });

  it("empty string token is treated as absent by NextRequest and returns 401", async () => {
    // NextRequest silently drops empty-string header values, so the route
    // sees no token and rejects with 401 — not a bypass vector.
    const response = await GET(makeRequest(""));
    expect(response.status).toBe(401);
  });
});
