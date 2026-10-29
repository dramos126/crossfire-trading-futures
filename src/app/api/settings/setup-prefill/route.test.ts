import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ hasWebAccount: vi.fn(() => false), brokerConfigured: true }));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));
vi.mock("@/lib/db/web-account", () => ({ hasWebAccount: h.hasWebAccount }));
vi.mock("@/lib/settings/tradovate-defaults", () => ({
  resolveTradovateAppIdentity: () => ({
    appId: "app",
    appVersion: "1.0",
    deviceId: "device",
    appIdAuto: true,
    appVersionAuto: true,
    deviceIdAuto: true,
  }),
}));
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    allPlugins: () => [
      { id: "topstep", displayName: "Topstep", isConfigured: () => h.brokerConfigured, credentialSchema: () => [] },
    ],
  },
}));

import { GET } from "./route";
import { resetSetupCodeForTests, SETUP_CODE_LINE_PREFIX } from "@/lib/auth/setup-code";

const ACCOUNT_NAME = "the-sign-in-name";

let write: ReturnType<typeof vi.spyOn>;

function setupCodeLines(): number {
  return write.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith(SETUP_CODE_LINE_PREFIX)).length;
}

beforeEach(() => {
  h.hasWebAccount.mockReturnValue(false);
  h.brokerConfigured = true;
  resetSetupCodeForTests();
  write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  write.mockRestore();
});

describe("GET /api/settings/setup-prefill — the setup code", () => {
  it("asks for it, and prints it once, on an install with a broker and no account", async () => {
    expect(await (await GET()).json()).toMatchObject({ needsSetupCode: true });
    await GET();
    expect(setupCodeLines()).toBe(1);
  });

  it("asks for none, and prints none, on a first run with no broker", async () => {
    h.brokerConfigured = false;
    expect(await (await GET()).json()).toMatchObject({ needsSetupCode: false });
    expect(setupCodeLines()).toBe(0);
  });

  it("never carries the code itself", async () => {
    await GET();
    const code = String(write.mock.calls[0][0]).slice(SETUP_CODE_LINE_PREFIX.length).trim();
    expect(await (await GET()).text()).not.toContain(code);
  });
});

describe("GET /api/settings/setup-prefill", () => {
  it("is open until a sign-in account exists, even with a broker already configured", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasAccount: false });
  });

  it("closes once the account exists, saying only that it does", async () => {
    h.hasWebAccount.mockReturnValue(true);
    const res = await GET();
    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    expect(body).toEqual({ error: "Already configured", hasAccount: true });
  });

  it("never carries the sign-in username, open or closed", async () => {
    for (const exists of [false, true]) {
      h.hasWebAccount.mockReturnValue(exists);
      const text = await (await GET()).text();
      expect(text).not.toContain(ACCOUNT_NAME);
      expect(text).not.toMatch(/"(username|accountName|webUsername)"/);
    }
    // The body above cannot hold a name the route never reads; this is what
    // keeps it from reading one.
    const source = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(source).not.toMatch(/webAccountUsername|FROM web_account/);
  });
});
