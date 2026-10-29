import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

// The root is absent on every readdir — the state staging and prod are in
// until the mount's subdirectory exists.
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async (dir: string) => {
    throw Object.assign(new Error(`ENOENT: ${dir}`), { code: "ENOENT" });
  }),
  readFile: vi.fn(async () => {
    throw new Error("readFile must not be reached with no root");
  }),
  stat: vi.fn(async () => {
    throw new Error("stat must not be reached with no root");
  }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";
import { validateSession } from "@/lib/db/auth";

function makeRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["x-session-token"] = token;
  return new NextRequest("http://localhost/api/backtest/runs", { headers });
}

beforeEach(() => {
  vi.mocked(validateSession).mockReturnValue(true);
  vi.stubEnv("BACKTEST_ARTIFACTS_DIR", "");
  vi.stubEnv("BAR_CACHE_DIR", "/mnt/cache");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/backtest/runs", () => {
  it("returns 401 without a session", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });

  it("answers an empty list, not a 500, when the artifact root is absent", async () => {
    const response = await GET(makeRequest("tok"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [] });
  });
});
