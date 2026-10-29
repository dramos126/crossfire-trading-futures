/**
 * The board's per-deployment flatten, over the wire.
 *
 * There is exactly one decision in this file that is not the primitive's,
 * and it is the one worth pinning: what a caller gets when there is no
 * engine to ask. The board renders from `positionMayStillBeOpen` rather than
 * from the status string — the whole reason that field exists — so an arm
 * that omits it renders a close that never happened as a completed one.
 *
 * That arm splits in two, on the same line the primitive's own `failed()`
 * splits on: `getEngineIfReady()` is null for *any* id an authenticated
 * caller supplies, so the engine-down arm must not page about a position it
 * never identified. The row read is what tells a stale board id from a close
 * that failed.
 *
 * The second property is that the route does not editorialise: whatever the
 * primitive answered is what comes back, `deferred` included. A route that
 * mapped a stood-down flatten onto a 409 or an `ok: false` would put the
 * status string back in the caller's way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// The row read that decides which event the engine-down arm reports. Stubbed
// rather than spread over the original: the real module reaches the strategy
// registry, whose `require.context` only exists under webpack.
vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => null),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(() => null),
}));

// The pipe, at its seam. The route emits through `log.event`; what this
// asserts is the *event name*, because that string is what carries the line
// to the durable store, to `/logs` and — through `KILL_SWITCH_EXEMPT` — to
// the one Discord alert the notifications toggle may not silence.
const { taggedEvent } = vi.hoisted(() => ({ taggedEvent: vi.fn() }));
vi.mock("@/lib/logging/pipe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/pipe")>()),
  taggedEvent,
}));

import { POST } from "./route";
import { getEngineIfReady } from "@/lib/trading/engine/engine-singleton";
import { getDeployment } from "@/lib/db/deployments";
import { EVENTS } from "@/lib/logging/vocabulary";
import type { Deployment } from "@/lib/trading/domain";
import type { ForceFlatResult } from "@/lib/trading/engine/flatten/engine-force-flat";
import { orderRequestsInFlight } from "@/lib/shutdown-drain";

const DEPL = "dep-1";

function makeRequest(opts: { token?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers["x-session-token"] = opts.token ?? "tok";
  return new NextRequest(`http://localhost/api/deployments/${DEPL}/flatten`, {
    method: "POST",
    headers,
  });
}

const ctx = { params: Promise.resolve({ id: DEPL }) };

/** An engine whose flatten call is observable. */
function engineWith(result: ForceFlatResult) {
  const forceFlatDeployment = vi.fn(async (_id: string) => result);
  vi.mocked(getEngineIfReady).mockReturnValue({
    forceFlatDeployment,
  } as unknown as ReturnType<typeof getEngineIfReady>);
  return forceFlatDeployment;
}

/** A row exists under this id. Only the id is read — the arm holds no
 *  account and no contract, which is the whole reason it may not page as if
 *  it did. */
function rowExists(): void {
  vi.mocked(getDeployment).mockReturnValue({ id: DEPL } as unknown as Deployment);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEngineIfReady).mockReturnValue(null);
  // The default is the stale-id shape, because it is the one an arbitrary id
  // reaches: `getDeployment` does not filter `deleted_at`, so null means no
  // row has ever existed.
  vi.mocked(getDeployment).mockReturnValue(null);
});

describe("POST /api/deployments/[id]/flatten", () => {
  it("hands the primitive the id from the path and returns its result verbatim", async () => {
    const result: ForceFlatResult = {
      deploymentId: DEPL,
      accountId: 5001,
      contractId: "CON.F.US.MNQ.Z26",
      status: "closed",
      size: 2,
      orderId: 44,
    };
    const flatten = engineWith(result);

    const res = await POST(makeRequest(), ctx);

    expect(flatten).toHaveBeenCalledWith(DEPL);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ result });
  });

  it("holds a SIGTERM's exit while the flatten is in flight", async () => {
    let finish!: (r: ForceFlatResult) => void;
    const flatten = vi.fn(() => new Promise<ForceFlatResult>((r) => (finish = r)));
    vi.mocked(getEngineIfReady).mockReturnValue({
      forceFlatDeployment: flatten,
    } as unknown as ReturnType<typeof getEngineIfReady>);

    const pending = POST(makeRequest(), ctx);
    await vi.waitFor(() => expect(flatten).toHaveBeenCalled());
    expect(orderRequestsInFlight()).toBe(1);

    finish({ deploymentId: DEPL, accountId: 5001, contractId: null, status: "already_flat" } as ForceFlatResult);
    await pending;
    expect(orderRequestsInFlight()).toBe(0);
  });

  it("passes a deferral through as a deferral, countdown and actor intact", async () => {
    // Two of the four statuses mean the position may still be open. A route
    // that collapsed `deferred` into a failure — or into an ok — would take
    // the honest answer away from the only surface that renders it.
    const result: ForceFlatResult = {
      deploymentId: DEPL,
      accountId: 5001,
      contractId: "CON.F.US.MNQ.Z26",
      status: "deferred",
      reason: "another flatten on this contract may still be unbooked",
      positionMayStillBeOpen: true,
      deferredTo: "force_flat",
      retryAfterMs: 12_000,
    };
    engineWith(result);

    const res = await POST(makeRequest(), ctx);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ result });
  });

  it("reports the engine-down arm as `deployment_flatten_failed` when the row exists", async () => {
    // The one `error` arm that never enters the primitive, and therefore the
    // one that never reaches `failed()`'s single reporter. Without this the
    // operator's flatten fails silently: no durable row, no `/logs` line, and
    // no alert on the one event the notifications kill-switch may not
    // silence — so a post-mortem finds no record a flatten was ever tried.
    rowExists();

    await POST(makeRequest(), ctx);

    expect(taggedEvent).toHaveBeenCalledTimes(1);
    const [event, , message, subject] = taggedEvent.mock.calls[0] as [
      string,
      string,
      string,
      { deploymentId?: string },
    ];
    expect(event).toBe("deployment_flatten_failed");
    expect(subject.deploymentId).toBe(DEPL);
    expect(message).toMatch(/may still be open/i);

    // Naming the event is the whole mechanism: the registry decides that it
    // is an error and that it escalates, and `KILL_SWITCH_EXEMPT` keys on
    // this exact string.
    expect(EVENTS.deployment_flatten_failed.severity).toBe("error");
    expect(EVENTS.deployment_flatten_failed.escalates).toBe(true);
  });

  it("takes `deployment_flatten_no_row` for an id no row has ever existed for", async () => {
    // The failure this splits: `getEngineIfReady()` is null on a
    // passive-no-creds boot and between restarts, so the arm above fires for
    // *any* id an authenticated caller supplies. Paging unconditionally would
    // put "the position may still be open" on the phone about a position this
    // route never identified — and the sender's throttle keys on the
    // deployment id, so N stale board ids are N pages the kill-switch may not
    // mute. Same shape as the primitive's own `NO_SUCH_ROW` split.
    await POST(makeRequest(), ctx);

    expect(taggedEvent).toHaveBeenCalledTimes(1);
    const [event, , message] = taggedEvent.mock.calls[0] as [string, string, string];
    expect(event).toBe("deployment_flatten_no_row");
    expect(message).not.toMatch(/may still be open/i);
    expect(message).toMatch(/nothing has been left open/i);

    // `warn`, and unflagged — which is the whole point of the second event.
    expect(EVENTS.deployment_flatten_no_row.severity).toBe("warn");
    expect(EVENTS.deployment_flatten_no_row.escalates).toBeFalsy();
  });

  it("omits `positionMayStillBeOpen` on the no-row result, not just in the line", async () => {
    // The field is what the surface renders *instead of* the status string,
    // so leaving it set would re-tell through the result the claim the second
    // event exists to stop telling — and offer a retry against an id that
    // will never resolve.
    const res = await POST(makeRequest(), ctx);
    const body = (await res.json()) as { result: ForceFlatResult };

    expect(res.status).toBe(200);
    expect(body.result.status).toBe("error");
    expect(body.result.positionMayStillBeOpen).toBeUndefined();
    expect(body.result.reason).toMatch(/no deployment with that id/i);
  });

  it("does not read the row when the engine is up — the primitive owns that", async () => {
    // A second read here would be a second place the two could disagree about
    // what the id names, and the primitive's read is the one the close is
    // built on.
    engineWith({ deploymentId: DEPL, accountId: 5001, contractId: null, status: "already_flat" });

    await POST(makeRequest(), ctx);

    expect(getDeployment).not.toHaveBeenCalled();
  });

  it("does not report when the primitive answered — it owns its own reporting", async () => {
    // `failed()` is the single reporter for every `error` the primitive can
    // return. A second line from the route would double every failure and
    // double the page that goes with it.
    engineWith({
      deploymentId: DEPL,
      accountId: 5001,
      contractId: "CON.F.US.MNQ.Z26",
      status: "error",
      reason: "the broker refused the order",
      positionMayStillBeOpen: true,
    });

    await POST(makeRequest(), ctx);

    expect(taggedEvent).not.toHaveBeenCalled();
  });

  it("answers an error result when there is no engine, and says the position may still be open", async () => {
    // The arm the primitive cannot answer for. `getEngineIfReady()` is null
    // on a passive-no-creds boot and between restarts; nothing reached the
    // wire, so this is exactly what `error` means and the field the board
    // renders from has to be set — otherwise a close that never happened
    // reads as a completed one.
    rowExists();

    const res = await POST(makeRequest(), ctx);
    const body = (await res.json()) as { result: ForceFlatResult };

    expect(res.status).toBe(200);
    expect(body.result.status).toBe("error");
    expect(body.result.positionMayStillBeOpen).toBe(true);
    expect(body.result.deploymentId).toBe(DEPL);
    expect(body.result.reason).toMatch(/engine is not running/i);
  });

  it("never constructs an engine to answer", async () => {
    // Same rule as the preflight's: a request must not start a trading engine
    // as a side effect. `getEngine()` would; `getEngineIfReady()` does not.
    await POST(makeRequest(), ctx);

    expect(getEngineIfReady).toHaveBeenCalledTimes(1);
  });

  it("refuses without a session and never reaches the engine", async () => {
    const res = await POST(makeRequest({ token: null }), ctx);

    expect(res.status).toBe(401);
    expect(getEngineIfReady).not.toHaveBeenCalled();
  });
});
