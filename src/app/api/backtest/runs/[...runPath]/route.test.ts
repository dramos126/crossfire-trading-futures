import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

// Every read throws: the assertion below is that an escaping path is
// refused *before* the filesystem is asked, so no fixture is needed.
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    throw new Error("readdir must not be reached");
  }),
  readFile: vi.fn(async () => {
    throw new Error("readFile must not be reached");
  }),
  stat: vi.fn(async () => {
    throw new Error("stat must not be reached");
  }),
}));

import { GET } from "./route";
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { validateSession } from "@/lib/db/auth";

function makeRequest(segments: string[]) {
  const request = new NextRequest("http://localhost/api/backtest/runs/x", {
    headers: { "x-session-token": "tok" },
  });
  return GET(request, { params: Promise.resolve({ runPath: segments }) });
}

beforeEach(() => {
  vi.mocked(validateSession).mockReturnValue(true);
  vi.mocked(readFile).mockClear();
  vi.stubEnv("BACKTEST_ARTIFACTS_DIR", "");
  vi.stubEnv("BAR_CACHE_DIR", "/mnt/cache");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/backtest/runs/[...runPath]", () => {
  it("answers 404 to a path that escapes the mount's backtests/ into the archive", async () => {
    const response = await makeRequest(["..", "ohlcv-1m", "MNQ.c.0"]);
    expect(response.status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("answers 404 to a percent-encoded escape", async () => {
    const response = await makeRequest(["%2e%2e", "ohlcv-1m"]);
    expect(response.status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });
});
