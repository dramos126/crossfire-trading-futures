import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  activateFromSettings: vi.fn(),
  getTopstepUsername: vi.fn(),
  setSetupConfirmedAt: vi.fn(),
  hasWebAccount: vi.fn(() => false),
  createWebAccount: vi.fn(
    async (): Promise<{ ok: true } | { ok: false; reason: "exists" }> => ({ ok: true }),
  ),
  topstepPlugin: {
    id: "topstep",
    isConfigured: vi.fn(() => false),
    computeCredsSignature: vi.fn(() => "topstep-sig"),
    applyCredentials: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => ({ transaction: (fn: () => unknown) => fn })),
  registerMigration: vi.fn(),
}));
vi.mock("@/lib/db/settings", () => ({
  getTopstepApiKey: vi.fn(() => null),
  getTopstepUsername: h.getTopstepUsername,
  getTradovateApiCid: vi.fn(() => null),
  getTradovateDeviceId: vi.fn(() => null),
  setSetupConfirmedAt: h.setSetupConfirmedAt,
  setSetupSignature: vi.fn(),
  setTopstepWebhookUrl: vi.fn(),
  setTradovateDeviceIdUserSet: vi.fn(),
}));
vi.mock("@/lib/db/settings-cache", () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock("@/lib/db/setup-signature", () => ({ computeConfigSignature: vi.fn(() => "sig") }));
vi.mock("@/lib/db/cred-validation", () => ({
  getTopstepCredsValidatedSignature: vi.fn(() => "topstep-sig"),
  setTopstepCredsValidatedSignature: vi.fn(),
  getTradovateCredsValidatedSignature: vi.fn(() => null),
}));
vi.mock("@/lib/db/web-account", () => ({
  hasWebAccount: h.hasWebAccount,
  createWebAccount: h.createWebAccount,
}));
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: {
    getPlugin: vi.fn((id: string) => (id === "topstep" ? h.topstepPlugin : null)),
    allPlugins: vi.fn(() => [h.topstepPlugin]),
  },
}));
vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  activateFromSettings: h.activateFromSettings,
}));

import { NextRequest } from "next/server";
import { POST } from "./route";
import { PASSWORD_TOO_SHORT_PROBLEM } from "@/lib/auth/web-account-rules";
import { LOGIN_FAILURE_LIMIT, resetLoginLimiterForTests } from "@/lib/auth/login-limiter";
import {
  ensureSetupCode,
  resetSetupCodeForTests,
  SETUP_CODE_LINE_PREFIX,
  setupCodeMatches,
} from "@/lib/auth/setup-code";

const ACCOUNT = { username: "operator", password: "correct horse battery" };

/** The code as the operator would read it: off the line printed to stdout. */
function printedSetupCode(): string {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  ensureSetupCode();
  const line = write.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith(SETUP_CODE_LINE_PREFIX));
  write.mockRestore();
  if (line === undefined) throw new Error("no setup code printed");
  return line.slice(SETUP_CODE_LINE_PREFIX.length).trim();
}

function setupRequest(body: Record<string, unknown> = {
  topstepUsername: "operator",
  topstepApiKey: "key",
  account: ACCOUNT,
}): NextRequest {
  return new NextRequest("http://localhost/api/settings/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTopstepUsername.mockReturnValue(null);
  h.hasWebAccount.mockReturnValue(false);
  h.createWebAccount.mockResolvedValue({ ok: true });
  h.topstepPlugin.isConfigured.mockReturnValue(false);
  resetLoginLimiterForTests();
  resetSetupCodeForTests();
});

describe("POST /api/settings/setup — engine activation", () => {
  it("activates the engine once after a completed setup", async () => {
    h.activateFromSettings.mockResolvedValue(undefined);
    const res = await POST(setupRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(h.topstepPlugin.applyCredentials).toHaveBeenCalledTimes(1);
    // Fire-and-forget behind the handle's lazy load, so it lands just after.
    await vi.waitFor(() => expect(h.activateFromSettings).toHaveBeenCalledTimes(1));
    expect(h.activateFromSettings).toHaveBeenCalledWith();
  });

  it("answers 200 without waiting on a refused activation, and swallows the rejection", async () => {
    h.activateFromSettings.mockRejectedValue(new Error("staging allowlist empty"));
    const res = await POST(setupRequest());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(h.activateFromSettings).toHaveBeenCalledTimes(1));
  });

  it("never activates when the wizard is already closed", async () => {
    h.getTopstepUsername.mockReturnValue("someone");
    const res = await POST(setupRequest());
    expect(res.status).toBe(409);
    expect(h.activateFromSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/setup — the sign-in account", () => {
  it("creates the account in the same confirm as the credentials, after them", async () => {
    const res = await POST(setupRequest());
    expect(res.status).toBe(200);
    expect(h.createWebAccount).toHaveBeenCalledWith(ACCOUNT.username, ACCOUNT.password);
    expect(h.topstepPlugin.applyCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      h.createWebAccount.mock.invocationCallOrder[0],
    );
    expect(h.setSetupConfirmedAt).toHaveBeenCalledTimes(1);
  });

  it("refuses a body without an account, and writes nothing", async () => {
    const res = await POST(setupRequest({ topstepUsername: "operator", topstepApiKey: "key" }));
    expect(res.status).toBe(400);
    expect(h.topstepPlugin.applyCredentials).not.toHaveBeenCalled();
    expect(h.createWebAccount).not.toHaveBeenCalled();
  });

  it("refuses a password under the length rule before writing anything", async () => {
    const res = await POST(
      setupRequest({ topstepUsername: "operator", topstepApiKey: "key", account: { username: "operator", password: "short" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: PASSWORD_TOO_SHORT_PROBLEM });
    expect(h.topstepPlugin.applyCredentials).not.toHaveBeenCalled();
  });

  it("cannot create an account twice: closed, with nothing written, once one exists", async () => {
    h.hasWebAccount.mockReturnValue(true);
    // Every shape the route takes: credentials plus account, and account alone
    // on an install whose broker already resolves.
    for (const body of [undefined, { account: { username: "intruder", password: "another long password" } }]) {
      h.topstepPlugin.isConfigured.mockReturnValue(body !== undefined);
      const res = await POST(setupRequest(body));
      expect(res.status).toBe(409);
    }
    expect(h.createWebAccount).not.toHaveBeenCalled();
    expect(h.topstepPlugin.applyCredentials).not.toHaveBeenCalled();
    expect(h.setSetupConfirmedAt).not.toHaveBeenCalled();
  });

  it("answers 409 when a racing create won between the check and the write", async () => {
    h.createWebAccount.mockResolvedValue({ ok: false, reason: "exists" });
    const res = await POST(setupRequest());
    expect(res.status).toBe(409);
    expect(h.setSetupConfirmedAt).not.toHaveBeenCalled();
  });

  it("creates the account alone on an install whose broker already resolves, with the printed code, and consumes it", async () => {
    h.topstepPlugin.isConfigured.mockReturnValue(true);
    h.getTopstepUsername.mockReturnValue("stored-before-sign-in-existed");
    const setupCode = printedSetupCode();
    const res = await POST(setupRequest({ account: ACCOUNT, setupCode }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accountCreated: true });
    expect(h.createWebAccount).toHaveBeenCalledWith(ACCOUNT.username, ACCOUNT.password);
    expect(h.topstepPlugin.applyCredentials).not.toHaveBeenCalled();
    expect(h.setSetupConfirmedAt).not.toHaveBeenCalled();
    expect(h.activateFromSettings).not.toHaveBeenCalled();
    expect(setupCodeMatches(setupCode)).toBe(false);
  });

  it("still needs a broker when none resolves and the body names none", async () => {
    const res = await POST(setupRequest({ account: ACCOUNT }));
    expect(res.status).toBe(400);
    expect(h.createWebAccount).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/setup — the setup code, on an install with a broker and no account", () => {
  beforeEach(() => {
    h.topstepPlugin.isConfigured.mockReturnValue(true);
  });

  it("refuses without the code, 403, and creates nothing", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const res = await POST(setupRequest({ account: ACCOUNT }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ needsSetupCode: true });
    expect(h.createWebAccount).not.toHaveBeenCalled();
    vi.mocked(process.stdout.write).mockRestore();
  });

  it("holds every body shape, not only the account-only one — an env-configured install's credential arm too", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const res = await POST(setupRequest());
    expect(res.status).toBe(403);
    expect(h.topstepPlugin.applyCredentials).not.toHaveBeenCalled();
    expect(h.createWebAccount).not.toHaveBeenCalled();
    vi.mocked(process.stdout.write).mockRestore();
  });

  it("counts a wrong code as a limiter failure: after the limit even the right one is a 429", async () => {
    const setupCode = printedSetupCode();
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      const wrong = await POST(setupRequest({ account: ACCOUNT, setupCode: "0".repeat(32) }));
      expect(wrong.status).toBe(403);
    }
    const res = await POST(setupRequest({ account: ACCOUNT, setupCode }));
    expect(res.status).toBe(429);
    expect(h.createWebAccount).not.toHaveBeenCalled();
  });

  it("never makes a second account, even with the right code", async () => {
    const setupCode = printedSetupCode();
    h.hasWebAccount.mockReturnValue(true);
    const res = await POST(setupRequest({ account: ACCOUNT, setupCode }));
    expect(res.status).toBe(409);
    expect(h.createWebAccount).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/setup — first run with no broker asks for no code", () => {
  it("creates the account in the credentials' confirm without one, and prints nothing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const res = await POST(setupRequest());
    expect(res.status).toBe(200);
    expect(h.createWebAccount).toHaveBeenCalledWith(ACCOUNT.username, ACCOUNT.password);
    expect(write.mock.calls.some((c) => String(c[0]).startsWith(SETUP_CODE_LINE_PREFIX))).toBe(false);
    write.mockRestore();
  });
});
