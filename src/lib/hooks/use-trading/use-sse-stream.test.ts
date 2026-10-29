// @vitest-environment jsdom
/**
 * The client half of the deployment lifecycle event.
 *
 * The decision under test — *a `deploymentsChanged` frame makes this tab
 * refetch its deployment list* — is one line inside a React effect's frame
 * dispatcher, and there is no other seam to reach it from. Lifting a
 * predicate out and asserting on that would prove the predicate rather than
 * that the dispatcher consults it, which is the failure being guarded
 * against: before this event the store hydrated once on mount and nothing
 * re-read it, so a pause in another tab never arrived at all.
 *
 * So the real hook is mounted and the assertion is on the requests it makes.
 *
 * The list read is **parked** rather than resolved, because the interesting
 * cases are all about what a frame does while a read is in flight, and a
 * fetch that resolves on its own turns that into a race the test hopes for.
 * `flush()` is the only thing that lets a read complete.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSseStream } from "./use-sse-stream";
import type { Action } from "./types";
import type { WireLogRecord } from "@/lib/logging/pipe";
import { clearEngineStatus, useEngineStatus, type EngineStatusBody } from "@/lib/hooks/use-engine-status";
import { subscribeLogLines } from "@/lib/hooks/log-line-feed";
import { SSE_IDLE_MS } from "@/lib/realtime/sse-heartbeat";

const T = vi.hoisted(() => ({ refreshAllTrades: vi.fn() }));
vi.mock("@/lib/hooks/use-trades", () => ({ refreshAllTrades: T.refreshAllTrades }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEPLOYMENTS_URL = "/api/deployments?includeTrash=true";

type StreamArgs = Parameters<typeof useSseStream>[0];

interface Stream {
  /** How many times the hook has opened the stream itself. */
  connects: () => number;
  /** How many list reads the hook has *issued*, settled or not. */
  reads: () => number;
  /** How many engine status reads — the setup readings' — it has issued. */
  setupReads: () => number;
  /** Reads parked and not yet released. `afterEach` asserts this reaches
   *  zero rather than draining blind, so a test parking more than the
   *  drain's budget fails loudly instead of leaking into the next mount. */
  inFlight: () => number;
  /** Every action the hook has dispatched, in order. */
  dispatched: () => Action[];
  /** Deliver another frame down the already-open stream. */
  push: (frame: string) => void;
  /** Settle every read currently in flight, then let the chain run. */
  flush: () => Promise<void>;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let stream: Stream | null = null;
/** What `useEngineStatus` rendered last, beside the hook under test. */
let heldStatus: EngineStatusBody | null = null;
const streamMarks = new Map<string, number>();

afterEach(async () => {
  // Drain before unmounting: `refreshDeployments` coalesces on module state,
  // so a read left parked here is a read still "in flight" for the next test
  // in this file, which would then see zero of its own.
  if (stream) {
    for (let i = 0; i < 5 && stream.inFlight() > 0; i++) await stream.flush();
    expect(stream.inFlight()).toBe(0);
  }
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  stream = null;
  heldStatus = null;
  streamMarks.clear();
  clearEngineStatus();
  T.refreshAllTrades.mockClear();
  vi.unstubAllGlobals();
});

function Harness({ args }: { args: StreamArgs }) {
  useSseStream(args);
  heldStatus = useEngineStatus();
  return null;
}

/**
 * Mount the real hook against a stubbed streaming `fetch` that hands back
 * `frames` and then parks — an open stream that has gone quiet, which is
 * what the relay looks like between events.
 */
function mountStream(
  frames: string[],
  targetAccountIds: number[] = [9001],
  { listStatus = 200, streamStatus = 200 }: { listStatus?: number; streamStatus?: number } = {},
): Stream {
  const urls: string[] = [];
  const encoder = new TextEncoder();
  const queue = [...frames];
  let wake: ((chunk: { value: Uint8Array; done: boolean }) => void) | null = null;
  const parked: Array<() => void> = [];
  const dispatch = vi.fn<(action: Action) => void>();

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      urls.push(url);
      if (url !== "/api/engine/stream") {
        return new Promise((resolve) => {
          const status = url === DEPLOYMENTS_URL ? listStatus : 200;
          parked.push(() =>
            resolve({ ok: status < 400, status, statusText: "", json: async () => ({ deployments: [] }) }),
          );
        });
      }
      if (streamStatus >= 400) {
        return Promise.resolve({ ok: false, status: streamStatus, body: null });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => {
              const next = queue.shift();
              if (next !== undefined) {
                return Promise.resolve({ value: encoder.encode(next), done: false });
              }
              // Park rather than close: a closed stream sends the hook into
              // its 30s reconnect loop, which is a different test.
              return new Promise<{ value: Uint8Array; done: boolean }>((resolve) => {
                wake = resolve;
              });
            },
            // What the idle watchdog calls: a parked read ends as a close.
            cancel: () => {
              if (wake) {
                const end = wake;
                wake = null;
                end({ value: new Uint8Array(), done: true });
              }
              return Promise.resolve();
            },
          }),
        },
      });
    }),
  );
  const args: StreamArgs = {
    token: "tok",
    targetAccountIds,
    openContractIds: [],
    targetAccountIdsRef: { current: targetAccountIds },
    openContractIdsRef: { current: [] },
    streamMarksRef: { current: streamMarks },
    dispatch,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { args })));

  stream = {
    connects: () => urls.filter((u) => u === "/api/engine/stream").length,
    reads: () => urls.filter((u) => u === DEPLOYMENTS_URL).length,
    setupReads: () => urls.filter((u) => u === "/api/engine").length,
    inFlight: () => parked.length,
    dispatched: () => dispatch.mock.calls.map(([action]) => action),
    push: (frame: string) => {
      if (wake) {
        const resume = wake;
        wake = null;
        resume({ value: encoder.encode(frame), done: false });
      } else {
        queue.push(frame);
      }
    },
    flush: async () => {
      for (const release of parked.splice(0)) release();
      await settle();
    },
  };
  return stream;
}

/** Let the read → dispatch → refetch chain settle. Each link is a microtask,
 *  so one flush is not enough. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function frame(kind: string, body: Record<string, unknown> = {}): string {
  return `event: ${kind}\ndata: ${JSON.stringify({ kind, ...body })}\n\n`;
}

function liveStates(s: Stream): boolean[] {
  return s.dispatched().flatMap((a) => (a.type === "LIVE_STATUS" ? [a.live] : []));
}

describe("useSseStream — deploymentsChanged", () => {
  it("refetches the deployment list when the frame arrives", async () => {
    const s = mountStream([frame("deploymentsChanged")]);

    await settle();

    expect(s.reads()).toBe(1);
  });

  it("stays open when nothing is engine-managed, because that is when a settle arrives", async () => {
    // The stream used to be gated on the target-account set being non-empty,
    // and that set is now derived from engine-managed deployments alone. So
    // pausing the last one emptied it, React tore this effect down mid-close,
    // and the `Paused` the engine settled to a moment later arrived at a
    // stream nobody was reading — leaving the row on `Pausing` for the life
    // of the tab. `accountIds` only drives the relay's hub subscriptions; the
    // lifecycle frame is global.
    const s = mountStream([frame("deploymentsChanged")], []);

    await settle();

    expect(s.reads()).toBe(1);
  });

  it("collapses a burst to the in-flight read plus one trailing read", async () => {
    // A group pause of N legs settles N times and each settle emits, so this
    // is the ordinary shape of the event, not a pathological one. What must
    // not happen is N reads per tab — and what must not happen instead is
    // *one*, because the frames after the first describe writes the in-flight
    // read was issued before, and nothing polls behind this store to correct
    // a snapshot that missed them.
    //
    // The three frames land inside one read-latency window, so they cost two
    // reads. A burst that outlives its own reads costs one more per window —
    // the drain loops rather than stopping at two, which is what keeps a slow
    // burst from being truncated.
    const s = mountStream([
      frame("deploymentsChanged"),
      frame("deploymentsChanged"),
      frame("deploymentsChanged"),
    ]);

    await settle();
    expect(s.reads()).toBe(1);

    await s.flush();
    expect(s.reads()).toBe(2);

    // And it stops there: no frame arrived during the trailing read, so the
    // loop exits rather than reading again.
    await s.flush();
    expect(s.reads()).toBe(2);
  });

  it("reads once per frame when each frame arrives after the last read settled", async () => {
    // The other half of the rule: coalescing is a response to concurrency,
    // never a rate limit. A quiet stream is still zero reads.
    const s = mountStream([frame("deploymentsChanged")]);

    await settle();
    await s.flush();
    expect(s.reads()).toBe(1);

    s.push(frame("deploymentsChanged"));
    await settle();
    expect(s.reads()).toBe(2);
  });

  it("does not refetch on the other event kinds", async () => {
    const s = mountStream([
      frame("status", { connected: true }),
      frame("marketTrade", { contractId: "MNQM6", lastPrice: 24681, timestamp: "2026-09-02T13:00:00.000Z" }),
    ]);

    await settle();

    expect(s.reads()).toBe(0);
  });
});

describe("useSseStream — a tab whose session is refused stays connected forever", () => {
  const refused: Action = { type: "SESSION_REFUSED", token: "tok" };

  it("reports a 401 on the deploymentsChanged refetch as a refused session", async () => {
    // The reset wipes the session and emits; the refetch the frame provokes is
    // the only thing that reaches this tab, and swallowing its 401 is what left
    // deleted deployments on the board indefinitely.
    const s = mountStream([frame("deploymentsChanged")], [9001], { listStatus: 401 });

    await settle();
    await s.flush();

    expect(s.dispatched()).toContainEqual(refused);
  });

  it("does not read a 500 or a dropped read as a refused session", async () => {
    const s = mountStream([frame("deploymentsChanged")], [9001], { listStatus: 500 });

    await settle();
    await s.flush();

    expect(s.dispatched()).not.toContainEqual(refused);
  });

  it("reports a 401 on the stream connect itself", async () => {
    // The stream validates the session once, at connect — so an expired one is
    // refused here on the next reconnect, with no frame to carry it.
    const s = mountStream([], [9001], { streamStatus: 401 });

    await settle();

    expect(s.dispatched()).toContainEqual(refused);
  });

  it("does not read the stream's 503 (realtime off) as a refused session", async () => {
    const s = mountStream([], [9001], { streamStatus: 503 });

    await settle();

    expect(s.dispatched()).not.toContainEqual(refused);
  });
});

describe("useSseStream — what the engine pushes instead of being polled", () => {
  const STATUS = {
    running: true,
    marketHub: { mode: "realtime", autoRetry: true, lastDisconnectReason: null },
    health: { marketData: { realtime: { state: "healthy", reason: null } }, degraded: false, frozen: [] },
    setups: {},
  };

  it("an engineStatus frame becomes the status every surface reads, with no read of the route", async () => {
    const s = mountStream([frame("engineStatus", { status: STATUS })]);
    await settle();
    expect(heldStatus).toEqual(STATUS);
    // The one /api/engine read is the setup readings' on open, not a status poll.
    expect(s.setupReads()).toBe(1);
  });

  it("a logLine frame reaches the /logs viewer's subscription", async () => {
    const seen: WireLogRecord[] = [];
    const off = subscribeLogLines((line) => seen.push(line));
    const record = {
      timestamp: "2026-10-27T14:30:00.000Z",
      deploymentId: "dep-1",
      level: "trade",
      message: "Entry filled",
      severity: "info",
      category: "trade",
      event: null,
      display: "…4469-ema-x.MNQ",
      ticker: "MNQ",
      tradeId: 7,
      values: null,
      burstCount: 1,
      seq: 0,
    };
    mountStream([frame("logLine", { record }), frame("logLine", { record: { message: 42 } })]);
    await settle();
    off();
    // The second is not a line at all and is dropped at the boundary.
    expect(seen).toEqual([record]);
  });

  it("a tradesChanged frame re-reads every trade subscription", async () => {
    mountStream([frame("tradesChanged")]);
    await settle();
    expect(T.refreshAllTrades).toHaveBeenCalledTimes(1);
  });

  it("a marketTrade frame records when the stream last marked that contract", async () => {
    mountStream([frame("marketTrade", { contractId: "MNQM6", lastPrice: 24681, timestamp: "2026-09-02T13:00:00.000Z" })]);
    await settle();
    expect(streamMarks.has("MNQM6")).toBe(true);
  });

  it("an order frame from an older server changes nothing — the orders slice is gone", async () => {
    mountStream([frame("order", { payload: { id: 1, accountId: 9001, status: 1 } })]);
    await settle();
    expect(stream!.dispatched().map((a) => a.type)).toEqual([]);
  });
});

// A half-open connection never errors, and with the 5 s polls gone nothing
// else would notice: `live` would stay true over surfaces frozen on their last
// value. Silence past the heartbeat's bound is a drop.
describe("useSseStream — the idle watchdog", () => {
  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stream that stops sending flips live false at the deadline", async () => {
    vi.useFakeTimers();
    const s = mountStream([frame("status", { connected: true })]);
    await settle();
    expect(liveStates(s)).toEqual([true]);

    await advance(SSE_IDLE_MS - 1);
    expect(liveStates(s)).toEqual([true]);

    await advance(1);
    expect(liveStates(s)).toEqual([true, false]);
  });

  it("a heartbeat resets the deadline", async () => {
    vi.useFakeTimers();
    const s = mountStream([frame("status", { connected: true })]);
    await settle();

    await advance(SSE_IDLE_MS - 1);
    s.push(": heartbeat\n\n");
    await settle();
    await advance(SSE_IDLE_MS - 1);
    expect(liveStates(s)).toEqual([true]);

    await advance(1);
    expect(liveStates(s)).toEqual([true, false]);
  });
});

// A page frozen in the background (a home-screen app on iOS) comes back with
// its stream half-open — no bytes, no error — and nothing but the idle bound
// and the 30 s retry would notice. The return itself is the signal.
describe("useSseStream — the page becoming visible again", () => {
  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("drops the open read and reopens the stream at once", async () => {
    const s = mountStream([frame("status", { connected: true })]);
    await settle();
    expect(s.connects()).toBe(1);

    await act(async () => setVisibility("visible"));
    await settle();

    // The drop ran — live went false — and the second connect is already
    // open, parked on its first read.
    expect(liveStates(s)).toEqual([true, false]);
    expect(s.connects()).toBe(2);
  });

  it("does nothing when the page is the one going hidden", async () => {
    const s = mountStream([frame("status", { connected: true })]);
    await settle();

    await act(async () => setVisibility("hidden"));
    await settle();

    expect(liveStates(s)).toEqual([true]);
    expect(s.connects()).toBe(1);
  });
});

describe("useSseStream — setupsChanged", () => {
  it("reads the setup readings once when the stream opens", async () => {
    const s = mountStream([frame("status", { connected: true })]);

    await settle();

    expect(s.setupReads()).toBe(1);
  });

  it("re-reads them on each setupsChanged frame, and on no other kind", async () => {
    const s = mountStream([frame("setupsChanged"), frame("deploymentsChanged")]);

    await settle();
    expect(s.setupReads()).toBe(2);

    s.push(frame("setupsChanged"));
    await settle();
    expect(s.setupReads()).toBe(3);
  });
});
