// @vitest-environment jsdom
/**
 * The poller's per-account read, which is the path that meets an expired
 * session first on a tab with positions open — every tick while the stream is
 * down, and the moment a hidden tab comes back to the foreground. And the
 * provider's sign-in lifecycle, which is a decision inside the hook, so it is
 * tested by mounting the hook.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { refreshAccountSnapshot, useTradingState } from "./use-trading-state";
import type { Action } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

function stubReads(positionsStatus: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: positionsStatus < 400,
        status: positionsStatus,
        json: async () => ({ positions: [], error: "x" }),
      }),
    ),
  );
}

describe("refreshAccountSnapshot — a tab whose session is refused stays connected forever", () => {
  it("hands a 401 to the provider as a refused session and loads nothing", async () => {
    stubReads(401);
    const dispatch = vi.fn<(action: Action) => void>();

    await refreshAccountSnapshot("tok", 9001, dispatch);

    expect(dispatch.mock.calls.map(([a]) => a)).toEqual([{ type: "SESSION_REFUSED", token: "tok" }]);
  });

  it("treats a 500 as transient: no refusal, nothing loaded over what the tab holds", async () => {
    stubReads(500);
    const dispatch = vi.fn<(action: Action) => void>();

    await refreshAccountSnapshot("tok", 9001, dispatch);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reads positions and nothing else — the orders slice is gone", async () => {
    stubReads(200);
    const dispatch = vi.fn<(action: Action) => void>();

    await refreshAccountSnapshot("tok", 9001, dispatch);

    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/api/positions?accountId=9001"]);
    expect(dispatch.mock.calls.map(([a]) => a)).toEqual([
      { type: "POSITIONS_LOADED", accountId: 9001, positions: [] },
    ]);
  });

  it("sends no session header — the cookie is the transport", async () => {
    stubReads(200);
    await refreshAccountSnapshot("tok", 9001, vi.fn());
    const calls = vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    for (const [, init] of calls) expect(JSON.stringify(init ?? {})).not.toContain("x-session-token");
  });
});

describe("the provider's sign-in lifecycle", () => {
  type Hook = ReturnType<typeof useTradingState>;
  let root: Root | null = null;
  let hook: Hook | null = null;
  const authBodies: Array<string | null> = [];

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    hook = null;
    authBodies.length = 0;
  });

  function Probe() {
    hook = useTradingState();
    return null;
  }

  /** `/api/auth` answers from the queue; everything else is an empty 200. */
  function stubServer(authAnswers: Array<{ status: number; body: unknown }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/auth") {
          authBodies.push(typeof init?.body === "string" ? init.body : null);
          const next = authAnswers.shift() ?? { status: 503, body: {} };
          return { ok: next.status < 400, status: next.status, json: async () => next.body };
        }
        if (url === "/api/accounts") {
          return { ok: true, status: 200, json: async () => ({ accounts: [] }) };
        }
        return { ok: false, status: 503, json: async () => ({}), body: null };
      }),
    );
  }

  async function mount() {
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(Probe)));
  }

  it("a resume with no session lands signed out and mints nothing", async () => {
    stubServer([{ status: 401, body: { signInRequired: true } }]);
    await mount();
    await act(async () => hook!.connect());
    expect(hook!.status).toBe("signedOut");
    expect(hook!.token).toBeNull();
    expect(authBodies).toEqual([null]);
  });

  it("a resume on a live cookie connects without a password", async () => {
    stubServer([{ status: 200, body: { signedIn: true, engineReady: true } }]);
    await mount();
    await act(async () => hook!.connect());
    expect(hook!.status).toBe("connected");
    expect(hook!.token).not.toBeNull();
    expect(authBodies).toEqual([null]);
  });

  it("a wrong pair is the form's to show — the provider stays signed out, not in error", async () => {
    stubServer([
      { status: 401, body: { signInRequired: true } },
      { status: 401, body: { invalidSignIn: true, error: "x" } },
    ]);
    await mount();
    await act(async () => hook!.connect());
    let failure: unknown;
    await act(async () => {
      failure = await hook!.signIn("operator", "not the password");
    });
    expect(failure).toEqual({ kind: "invalid-sign-in" });
    expect(hook!.status).toBe("signedOut");
    expect(JSON.parse(authBodies[1] ?? "{}")).toEqual({ username: "operator", password: "not the password" });
  });

  it("a right pair connects, and each session gets its own marker", async () => {
    stubServer([
      { status: 200, body: { signedIn: true, engineReady: true } },
      { status: 200, body: { signedIn: true, engineReady: true } },
    ]);
    await mount();
    await act(async () => hook!.connect());
    const first = hook!.token;
    await act(async () => {
      await hook!.signIn("operator", "correct horse battery");
    });
    expect(hook!.status).toBe("connected");
    expect(hook!.token).not.toBe(first);
  });

  it("a broker that refuses puts the provider in error with a kind, not raw text for the banner", async () => {
    stubServer([{ status: 401, body: { error: "Topstep loginKey 401 errorCode 3" } }]);
    await mount();
    await act(async () => hook!.connect());
    expect(hook!.status).toBe("error");
    expect(hook!.errorKind).toBe("broker-refused");
  });
});
