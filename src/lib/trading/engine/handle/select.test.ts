/**
 * The chooser: the in-process handle where the engine runs, the remote one
 * in a `web` process, and a clear error at first use when a `web` process is
 * missing what it needs to reach the engine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  local: { kind: "local" },
  remote: vi.fn((url: string, secret: string) => ({ kind: "remote", url, secret })),
}));

vi.mock("@/lib/trading/engine/handle/local", () => ({ localEngineHandle: () => h.local }));
vi.mock("@/lib/trading/engine/handle/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/engine/handle/remote")>()),
  remoteEngineHandle: h.remote,
}));

import { engineHandle, isEngineUnreachable } from "./select";
import { EngineRemoteError, EngineUnreachableError } from "./remote";
import { EngineNotInThisProcessError } from "@/lib/role";

const HANDLE_KEY = "__crossfireEngineHandle";
const SECRET = "internal-secret-under-test-32-chars-plus";
const KEYS = ["CROSSFIRE_ROLE", "CROSSFIRE_ENGINE_URL", "CROSSFIRE_INTERNAL_SECRET"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  h.remote.mockClear();
  delete (globalThis as Record<string, unknown>)[HANDLE_KEY];
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE_KEY];
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("engineHandle", () => {
  it.each([undefined, "all", "engine"])("is the local handle in role %s, and reads no URL or secret", (role) => {
    if (role) process.env.CROSSFIRE_ROLE = role;
    expect(engineHandle()).toBe(h.local);
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("is the remote handle in the web role, at the URL with the secret", () => {
    process.env.CROSSFIRE_ROLE = "web";
    process.env.CROSSFIRE_ENGINE_URL = "http://engine:3000";
    process.env.CROSSFIRE_INTERNAL_SECRET = SECRET;
    expect(engineHandle()).toEqual({ kind: "remote", url: "http://engine:3000", secret: SECRET });
  });

  it("is chosen once: one remote handle, and so one upstream stream, per process", () => {
    process.env.CROSSFIRE_ROLE = "web";
    process.env.CROSSFIRE_ENGINE_URL = "http://engine:3000";
    process.env.CROSSFIRE_INTERNAL_SECRET = SECRET;
    const first = engineHandle();
    process.env.CROSSFIRE_ENGINE_URL = "http://elsewhere:3000";
    expect(engineHandle()).toBe(first);
    expect(h.remote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no URL", { CROSSFIRE_INTERNAL_SECRET: SECRET }, "CROSSFIRE_ENGINE_URL is not set"],
    ["a host with no scheme", { CROSSFIRE_ENGINE_URL: "engine:3000", CROSSFIRE_INTERNAL_SECRET: SECRET }, "is not an http(s) URL"],
    ["no URL at all", { CROSSFIRE_ENGINE_URL: "not a url", CROSSFIRE_INTERNAL_SECRET: SECRET }, "is not an http(s) URL"],
    ["no secret", { CROSSFIRE_ENGINE_URL: "http://engine:3000" }, "CROSSFIRE_INTERNAL_SECRET is not set"],
    ["an empty secret", { CROSSFIRE_ENGINE_URL: "http://engine:3000", CROSSFIRE_INTERNAL_SECRET: "" }, "CROSSFIRE_INTERNAL_SECRET is not set"],
    ["a short secret", { CROSSFIRE_ENGINE_URL: "http://engine:3000", CROSSFIRE_INTERNAL_SECRET: "s3cret" }, "it needs at least 32"],
  ])("throws a clear error at first use in the web role with %s, every time until fixed", (_label, env, message) => {
    process.env.CROSSFIRE_ROLE = "web";
    Object.assign(process.env, env);
    expect(() => engineHandle()).toThrow(message);
    expect(() => engineHandle()).toThrow(message);
    expect(h.remote).not.toHaveBeenCalled();
  });

  it("names the URL variable without echoing its value, which may carry credentials", () => {
    process.env.CROSSFIRE_ROLE = "web";
    process.env.CROSSFIRE_ENGINE_URL = "ftp://user:hunter2@engine:3000";
    process.env.CROSSFIRE_INTERNAL_SECRET = SECRET;
    expect(() => engineHandle()).toThrow(/^CROSSFIRE_ENGINE_URL is not an http\(s\) URL$/);
  });
});

describe("isEngineUnreachable", () => {
  it("is true for no answer from the engine process, a timeout included", () => {
    expect(isEngineUnreachable(new EngineUnreachableError("forceFlatDeployment", "timed out after 60000 ms"))).toBe(true);
  });

  it.each([
    ["an answer that was an error", new EngineRemoteError("Error", "boom", 500)],
    ["the web role's own refusal", new EngineNotInThisProcessError("getEngine()")],
    ["any other error", new Error("engine process unreachable")],
    ["a non-error", "EngineUnreachableError"],
  ])("is false for %s", (_label, err) => {
    expect(isEngineUnreachable(err)).toBe(false);
  });
});
