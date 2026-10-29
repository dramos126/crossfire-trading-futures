/**
 * D-11's activation preflight.
 *
 * `parseBody` and `toParamValues` are hand-rolled validators on a boundary,
 * and neither is exported — so they are exercised through the handler, which
 * is also the only way to check that what survives narrowing is what reaches
 * `previewManualPositionClaim`. Two properties carry the weight: an
 * unrecognised param key is *dropped* rather than rejected, because refusing
 * the whole body over one would leave the operator with no prompt at all, and
 * a null engine answers `{ available: false }` rather than an empty position
 * list, because an empty list reads as "nothing will be closed".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(() => null),
}));

import { POST } from "./route";
import { getEngineIfReady } from "@/lib/trading/engine/engine-singleton";

const PREVIEW = {
  root: "MGC",
  inWindow: false,
  whenNy: "09:30",
  positions: [{ contractId: "CON.F.US.MGC.G27", side: "LONG", size: 2 }],
};

function makeRequest(body: unknown, opts: { token?: string | null; raw?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== null) headers["x-session-token"] = opts.token ?? "tok";
  return new NextRequest("http://localhost/api/deployments/manual-position-preflight", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

/** Exactly what `parseBody` is supposed to hand the guard. */
interface PreviewInput {
  accountId: number;
  ticker: string;
  strategyKey: string;
  paramValues: Record<string, unknown>;
  live: boolean;
}

/** An engine whose preview call is observable. */
function engineWith(preview: unknown = PREVIEW) {
  const previewManualPositionClaim = vi.fn(async (_input: PreviewInput) => preview);
  vi.mocked(getEngineIfReady).mockReturnValue({
    previewManualPositionClaim,
  } as unknown as ReturnType<typeof getEngineIfReady>);
  return previewManualPositionClaim;
}

const VALID = {
  accountId: 4242,
  ticker: "/MGC",
  strategyKey: "test-strategy",
  paramValues: { pauseWindows: [{ start: "12:00", end: "13:00" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEngineIfReady).mockReturnValue(null);
});

describe("POST /api/deployments/manual-position-preflight — the session gate", () => {
  it("refuses without a session token", async () => {
    const res = await POST(makeRequest(VALID, { token: null }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/deployments/manual-position-preflight — parseBody", () => {
  it("rejects a body that is not JSON", async () => {
    const res = await POST(makeRequest(null, { raw: "<html>" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid JSON body" });
  });

  it("rejects a JSON body that is not an object", async () => {
    const res = await POST(makeRequest(null, { raw: "[1,2,3]" }));
    expect(res.status).toBe(400);
  });

  for (const [label, body] of [
    ["accountId missing", { ticker: "/MGC", strategyKey: "s" }],
    ["accountId as a string", { accountId: "4242", ticker: "/MGC", strategyKey: "s" }],
    ["ticker missing", { accountId: 1, strategyKey: "s" }],
    ["strategyKey missing", { accountId: 1, ticker: "/MGC" }],
  ] as const) {
    it(`rejects when ${label}`, async () => {
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
    });
  }

  it("rejects a ticker the app does not trade", async () => {
    // Not a shape check — the symbol has to be in TICKER_OPTIONS, or the
    // resolver downstream is asked for a contract that does not exist.
    const res = await POST(makeRequest({ ...VALID, ticker: "/DOGE" }));
    expect(res.status).toBe(400);
  });

  it("accepts a body with no paramValues at all, as an empty map", async () => {
    const preview = engineWith();
    const res = await POST(
      makeRequest({ accountId: 4242, ticker: "/MGC", strategyKey: "test-strategy" }),
    );
    expect(res.status).toBe(200);
    expect(preview.mock.calls[0][0].paramValues).toEqual({});
  });

  it("treats an array paramValues as no params rather than indexing it", async () => {
    const preview = engineWith();
    await POST(makeRequest({ ...VALID, paramValues: ["09:30"] }));
    expect(preview.mock.calls[0][0].paramValues).toEqual({});
  });

  it("carries live: true through to the guard — the activation prompt's live read", async () => {
    const preview = engineWith();
    await POST(makeRequest({ ...VALID, live: true }));
    expect(preview.mock.calls[0][0].live).toBe(true);
  });

  for (const [label, live] of [["absent", undefined], ["a string", "true"], ["false", false]] as const) {
    it(`reads the account view when live is ${label} — the board strip's probe`, async () => {
      const preview = engineWith();
      await POST(makeRequest({ ...VALID, live }));
      expect(preview.mock.calls[0][0].live).toBe(false);
    });
  }
});

describe("POST /api/deployments/manual-position-preflight — toParamValues", () => {
  it("keeps strings, numbers and booleans", async () => {
    const preview = engineWith();
    await POST(
      makeRequest({ ...VALID, paramValues: { size: 2, tag: "a", trailEnabled: true } }),
    );
    expect(preview.mock.calls[0][0].paramValues).toEqual({ size: 2, tag: "a", trailEnabled: true });
  });

  it("drops a timezoned window — the trading window is the playbook's, not the body's", async () => {
    // The wire carried a `mainSession` until the session became a playbook
    // constant. A body that can still name one is a body that can ask the
    // preflight about a window the engine does not run.
    const preview = engineWith();
    await POST(
      makeRequest({
        ...VALID,
        paramValues: { mainSession: { start: "09:30", end: "16:00", timezone: "America/New_York" } },
      }),
    );
    expect(preview.mock.calls[0][0].paramValues).toEqual({});
  });

  it("keeps an array of pause windows", async () => {
    const preview = engineWith();
    const pauseWindows = [{ start: "12:00", end: "13:00" }];
    await POST(makeRequest({ ...VALID, paramValues: { pauseWindows } }));
    expect(preview.mock.calls[0][0].paramValues).toEqual({ pauseWindows });
  });

  it("drops an array whose entries are not HH:MM pairs", async () => {
    const preview = engineWith();
    await POST(makeRequest({ ...VALID, paramValues: { pauseWindows: [{ start: "12:00" }] } }));
    expect(preview.mock.calls[0][0].paramValues).toEqual({});
  });

  it("drops an unrecognised key instead of rejecting the whole body", async () => {
    // Dropping is the right answer for a *preview*: an unrecognised key cannot
    // change which session windows come out, and a 400 would leave the
    // operator with no prompt.
    const preview = engineWith();
    const res = await POST(
      makeRequest({ ...VALID, paramValues: { ...VALID.paramValues, nested: { a: { b: 1 } } } }),
    );
    expect(res.status).toBe(200);
    const sent = preview.mock.calls[0][0];
    expect(sent.paramValues.nested).toBeUndefined();
    expect(sent.paramValues.pauseWindows).toBeDefined();
  });

  it("drops a null value rather than carrying it through", async () => {
    const preview = engineWith();
    await POST(makeRequest({ ...VALID, paramValues: { pauseWindows: null } }));
    expect(preview.mock.calls[0][0].paramValues).toEqual({});
  });
});

describe("POST /api/deployments/manual-position-preflight — the answer", () => {
  it("answers available:false with a null preview when no engine is ready", async () => {
    const res = await POST(makeRequest(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, preview: null });
  });

  it("never constructs an engine to answer a question", async () => {
    await POST(makeRequest(VALID));
    expect(getEngineIfReady).toHaveBeenCalledTimes(1);
  });

  it("returns the guard's own preview when the engine is ready", async () => {
    engineWith();
    const res = await POST(makeRequest(VALID));
    expect(await res.json()).toEqual({ available: true, preview: PREVIEW });
  });

  it("reports a preview failure as a 500 rather than as nothing-will-be-closed", async () => {
    const preview = engineWith();
    preview.mockRejectedValue(new Error("broker unreachable"));
    const res = await POST(makeRequest(VALID));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "broker unreachable" });
  });

  it("places nothing — the only engine method it may reach is the preview", async () => {
    const previewManualPositionClaim = vi.fn(async () => PREVIEW);
    const placeExitOrder = vi.fn();
    const flattenAll = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      previewManualPositionClaim,
      placeExitOrder,
      flattenAll,
    } as unknown as ReturnType<typeof getEngineIfReady>);

    await POST(makeRequest(VALID));

    expect(previewManualPositionClaim).toHaveBeenCalledTimes(1);
    expect(placeExitOrder).not.toHaveBeenCalled();
    expect(flattenAll).not.toHaveBeenCalled();
  });
});
