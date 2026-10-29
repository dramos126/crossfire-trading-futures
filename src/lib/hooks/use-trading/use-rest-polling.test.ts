// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QUOTE_STREAM_QUIET_MS,
  contractsNeedingQuote,
  createContractMetaRetry,
  useRestPolling,
} from "./use-rest-polling";

// `createContractMetaRetry` is pure and env-agnostic; the polling-cadence
// cases below mount the real hook, because the cadence is an inline
// expression inside its effect and there is no other seam to reach it from.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("createContractMetaRetry", () => {
  it("lets an id through on first sight", () => {
    const retry = createContractMetaRetry();
    expect(retry.isDue("MNQM6", 0)).toBe(true);
  });

  it("holds an id back on the tick after a failed attempt", () => {
    const retry = createContractMetaRetry();
    retry.reserve("MNQM6", 10);
    expect(retry.isDue("MNQM6", 11)).toBe(false);
  });

  it("lets a transient failure retry once the backoff elapses", () => {
    const retry = createContractMetaRetry();
    retry.reserve("MNQM6", 10);
    expect(retry.isDue("MNQM6", 12)).toBe(true);
  });

  it("doubles the wait on each consecutive failure", () => {
    const retry = createContractMetaRetry();
    // Reserve at the tick each retry becomes due, so the delays compound
    // the way a genuinely unresolvable id's would.
    retry.reserve("MNQM6", 0);
    expect(retry.isDue("MNQM6", 1)).toBe(false);
    expect(retry.isDue("MNQM6", 2)).toBe(true);

    retry.reserve("MNQM6", 2);
    expect(retry.isDue("MNQM6", 5)).toBe(false);
    expect(retry.isDue("MNQM6", 6)).toBe(true);

    retry.reserve("MNQM6", 6);
    expect(retry.isDue("MNQM6", 13)).toBe(false);
    expect(retry.isDue("MNQM6", 14)).toBe(true);
  });

  it("caps the wait so a dead id still gets re-asked, and never gives up", () => {
    const retry = createContractMetaRetry();
    let tick = 0;
    for (let i = 0; i < 40; i++) {
      retry.reserve("MNQM6", tick);
      // Walk forward to the next due tick. If the backoff were unbounded
      // this loop would run past any plausible session length.
      let waited = 0;
      while (!retry.isDue("MNQM6", tick) && waited <= 200) {
        tick++;
        waited++;
      }
      expect(waited).toBeLessThanOrEqual(120);
    }
    expect(retry.isDue("MNQM6", tick)).toBe(true);
  });

  it("re-asks immediately after a success clears the backoff", () => {
    const retry = createContractMetaRetry();
    retry.reserve("MNQM6", 10);
    retry.clear("MNQM6");
    expect(retry.isDue("MNQM6", 10)).toBe(true);
  });

  it("backs off each id independently", () => {
    const retry = createContractMetaRetry();
    retry.reserve("MNQM6", 10);
    expect(retry.isDue("MESM6", 10)).toBe(true);
  });

  it("forgets ids that are no longer held", () => {
    const retry = createContractMetaRetry();
    retry.reserve("MNQM6", 0);
    retry.reserve("MNQM6", 2);
    retry.reserve("MNQM6", 6);
    retry.retain(["MESM6"]);
    // The position closed and reopened — start from a clean slate rather
    // than inheriting a backoff earned in a previous session.
    expect(retry.isDue("MNQM6", 7)).toBe(true);
  });

  it("keeps the backoff for an id that is still held", () => {
    const retry = createContractMetaRetry();
    retry.reserve("MNQM6", 10);
    retry.retain(["MNQM6", "MESM6"]);
    expect(retry.isDue("MNQM6", 11)).toBe(false);
  });
});

describe("contractsNeedingQuote — stream first, REST for what it is not carrying", () => {
  const NOW = 1_761_575_400_000;

  it("asks for every open contract while the stream is down", () => {
    const marks = new Map([["MNQM6", NOW]]);
    expect(contractsNeedingQuote(["MNQM6", "MESZ6"], false, marks, NOW)).toEqual(["MNQM6", "MESZ6"]);
  });

  it("while it is up, asks only for a contract it has never marked or has gone quiet on", () => {
    const marks = new Map([
      ["MNQM6", NOW - 1_000],
      ["MESZ6", NOW - QUOTE_STREAM_QUIET_MS],
    ]);
    expect(contractsNeedingQuote(["MNQM6", "MESZ6", "MYMZ6"], true, marks, NOW)).toEqual([
      "MESZ6",
      "MYMZ6",
    ]);
  });
});

// ── Polling cadence ──────────────────────────────────────────────────

type PollingArgs = Parameters<typeof useRestPolling>[0];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** jsdom's `visibilityState` is a getter on the document; shadow it per test. */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

afterEach(() => {
  setVisibility("visible");
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Harness({ args }: { args: PollingArgs }) {
  useRestPolling(args);
  return null;
}

interface MountOptions {
  live: boolean;
  contracts?: string[];
  /** When the stream last marked each contract. */
  streamMarks?: Map<string, number>;
}

/** Mount the real hook with one account, one open contract whose meta is
 *  already cached (so the lazy meta loop stays out of the way), and a
 *  stubbed `fetch`. Returns the urls it was asked for. */
function mountPolling(opts: MountOptions): {
  urls: string[];
  bodies: unknown[];
  refreshAccount: ReturnType<typeof vi.fn>;
} {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      urls.push(url);
      if (init?.body) bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ quotes: {} }) };
    }),
  );
  const contracts = opts.contracts ?? ["MNQM6"];
  const refreshAccount = vi.fn(async () => {});
  const args: PollingArgs = {
    token: "tok",
    refreshAccount,
    dispatch: vi.fn(),
    tokenRef: { current: "tok" },
    targetAccountIdsRef: { current: [9001] },
    openContractIdsRef: { current: contracts },
    contractMetaRef: {
      current: Object.fromEntries(
        contracts.map((id) => [id, { tickSize: 0.25, tickValue: 0.5, name: id }]),
      ),
    },
    liveRef: { current: opts.live },
    streamMarksRef: { current: opts.streamMarks ?? new Map() },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { args })));
  return { urls, bodies, refreshAccount };
}

describe("useRestPolling — quote cadence", () => {
  it("polls /api/quotes on every tick while the SSE stream is down", async () => {
    vi.useFakeTimers();
    const { urls } = mountPolling({ live: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(urls.filter((u) => u === "/api/quotes")).toHaveLength(3);
  });

  it("still polls /api/quotes on the reconcile tick for a contract the live stream is not marking", async () => {
    vi.useFakeTimers();
    const { urls } = mountPolling({ live: true });

    // Ticks 1-3 ride the stream; tick 4 is the reconcile, and the quote
    // read rides it. Gating this on `live` alone made the alias the single
    // path to a Tradovate mark — see bugs.md.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(urls.filter((u) => u === "/api/quotes")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(urls.filter((u) => u === "/api/quotes")).toHaveLength(1);
  });

  it("asks for no quote in a minute while the live stream keeps marking the contract", async () => {
    vi.useFakeTimers();
    const streamMarks = new Map<string, number>();
    const { urls } = mountPolling({ live: true, streamMarks });

    for (let s = 0; s < 60; s++) {
      streamMarks.set("MNQM6", Date.now());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    expect(urls.filter((u) => u === "/api/quotes")).toHaveLength(0);
  });

  it("does not tick while the tab is hidden, and ticks once with a reconcile on becoming visible", async () => {
    // A115: up to three tabs open, and the background ones polled for nobody.
    vi.useFakeTimers();
    setVisibility("hidden");
    const { urls, refreshAccount } = mountPolling({ live: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(refreshAccount).not.toHaveBeenCalled();
    expect(urls).toHaveLength(0);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // Live, so tick 1 alone would ride the stream; the resume tick reconciles.
    expect(refreshAccount).toHaveBeenCalledTimes(1);
    expect(urls.filter((u) => u === "/api/quotes")).toHaveLength(1);
  });

  it("asks for the ids the browser holds positions under, not translated ones", async () => {
    vi.useFakeTimers();
    // The route owns the translation, because only the engine can do it.
    // Sending anything else here would break the rekey on the way back.
    const { urls, bodies } = mountPolling({ live: false, contracts: ["MNQM6"] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(urls).toContain("/api/quotes");
    expect(bodies[0]).toEqual({ contractIds: ["MNQM6"] });
  });
});
