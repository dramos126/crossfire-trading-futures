// @vitest-environment jsdom
/**
 * When `useTrades` is allowed to throw its answer away.
 *
 * The hook's state is per-hook and only ever written from a settled fetch, so
 * something has to clear it when the question changes — otherwise one leg's
 * account name sits above the all-accounts totals for a round trip, and
 * forever if that fetch never lands. The reset that does this used to be the
 * `else` of *"this subscription has no cached snapshot"*, which is a different
 * fact from *"the question changed"* and true in one case where the question
 * did not: `token` is a dependency of the subscribing effect but not part of
 * the subscription key, so a rotation tears the subscription down (last
 * subscriber out deletes it) and rebuilds it against the same query.
 *
 * That case is not hypothetical — `createSession` mints a new token on every
 * `POST /api/auth`, so every `connect()` rotates it, including the board's
 * Reconnect button. Blanking there empties `buildBoard`'s open-position map,
 * which draws a leg holding a live position as flat with a structurally valid
 * `$0.00` beside it: the exact reading `design-language.md`'s Hard rule
 * forbids.
 *
 * Both directions are pinned here, because a guard that never resets is the
 * bug this reset exists to fix.
 *
 * The registry is module scope, so each test takes a **fresh module
 * registry**; `react` is externalized and keeps its identity across the reset,
 * so the statically imported `act` still drives these mounts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { useTradingState } from "./use-trading/use-trading-state";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.resetModules();
});

function trade(id: number): StrategyTrade {
  return { id, accountId: 5001, deploymentId: "dep-1" } as unknown as StrategyTrade;
}

const RESPONSE = {
  trades: [trade(1), trade(2)],
  summary: { openTrades: 0, closedTrades: 2 },
  slippage: null,
  dailyPnlGate: null,
};

/**
 * Mount the real hook under a real `TradingContext`, against a `fetch` that
 * answers immediately. `seen` records what the hook has rendered on each pass
 * so a blank between two populated renders is visible rather than raced past.
 */
async function harness(answer: (call: number) => boolean = () => true) {
  vi.resetModules();
  const mod = await import("./use-trades");
  const { TradingContext } = await import("./use-trading/use-trading-state");

  // `answer(n)` decides whether the n-th fetch (0-based) answers or 500s.
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        answer(calls++)
          ? { ok: true, json: async () => RESPONSE }
          : { ok: false, json: async () => ({ error: "boom" }) },
      ),
    ),
  );

  const seen: Array<{ trades: number; loading: boolean }> = [];
  const reads: boolean[] = [];

  function Probe({ accountId }: { accountId: number | null }) {
    const { trades, loading, tradesRead } = mod.useTrades({ accountId });
    seen.push({ trades: trades.length, loading });
    reads.push(tradesRead);
    return null;
  }

  function Wrap({ token, accountId }: { token: string; accountId: number | null }): ReactNode {
    return createElement(
      TradingContext.Provider,
      { value: { token } as unknown as ReturnType<typeof useTradingState> },
      createElement(Probe, { accountId }),
    );
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  const render = async (token: string, accountId: number | null) => {
    await act(async () => {
      root!.render(Wrap({ token, accountId }));
    });
    // The fetch → notify → setState chain is several microtasks deep.
    for (let i = 0; i < 6; i++) await act(async () => void (await Promise.resolve()));
  };

  return { seen, reads, render };
}

describe("useTrades — a rotated token is not a new question", () => {
  it("keeps the rows on screen when only the session token changed", async () => {
    const { seen, render } = await harness();

    await render("tok-1", null);
    expect(seen.at(-1)).toEqual({ trades: 2, loading: false });

    const before = seen.length;
    await render("tok-2", null);

    // The whole point: not one render between the rotation and the next
    // answer may show an empty list. A board reading this would draw an open
    // position as flat.
    const during = seen.slice(before);
    expect(during.every((s) => s.trades === 2)).toBe(true);
    expect(during.every((s) => !s.loading)).toBe(true);
  });

  it("clears them when the account scope changed", async () => {
    const { seen, render } = await harness();

    await render("tok-1", null);
    expect(seen.at(-1)).toEqual({ trades: 2, loading: false });

    const before = seen.length;
    await render("tok-1", 5001);

    // The other direction. Without a blank here the previous scope's totals
    // render under the new scope's label, which is the defect the reset was
    // added for — so a guard that made the first test pass by never resetting
    // fails this one.
    const during = seen.slice(before);
    expect(during.some((s) => s.trades === 0 && s.loading)).toBe(true);
    expect(seen.at(-1)).toEqual({ trades: 2, loading: false });
  });

  it("does not blank on the very first render, which has nothing to blank", async () => {
    const { seen, render } = await harness();

    await render("tok-1", null);

    // `prevKey` starts empty, and an empty key is not a question anyone asked.
    // Resetting on it would be harmless but would also mean the guard is
    // reading "" as a real previous scope.
    expect(seen[0]).toEqual({ trades: 0, loading: true });
    expect(seen.at(-1)).toEqual({ trades: 2, loading: false });
  });
});

describe("useTrades — the stream re-reads, a timer only covers a down stream", () => {
  /** Mount under a context whose `live` the test sets, on a fake clock, and
   *  count the reads. `fetch` answers at once. */
  async function streamHarness() {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import("./use-trades");
    const { TradingContext } = await import("./use-trading/use-trading-state");
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        reads++;
        return Promise.resolve({ ok: true, json: async () => RESPONSE });
      }),
    );
    function Probe() {
      mod.useTrades({ accountId: null });
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = async (live: boolean) => {
      await act(async () => {
        root!.render(
          createElement(
            TradingContext.Provider,
            { value: { token: "tok-1", live } as unknown as ReturnType<typeof useTradingState> },
            createElement(Probe),
          ),
        );
      });
    };
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    return { reads: () => reads, render, advance, refreshAllTrades: mod.refreshAllTrades };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads once and arms no timer while the stream is up: a minute costs one read", async () => {
    const h = await streamHarness();
    await h.render(true);
    await h.advance(60_000);
    expect(h.reads()).toBe(1);
  });

  it("re-reads on each tradesChanged while up", async () => {
    const h = await streamHarness();
    await h.render(true);
    await h.advance(0);
    await act(async () => h.refreshAllTrades());
    await h.advance(0);
    expect(h.reads()).toBe(2);
  });

  it("follows a read that was already out with one more, so a write it raced is not lost", async () => {
    const h = await streamHarness();
    await h.render(true);
    expect(h.reads()).toBe(1);
    // Three frames in one turn: the first starts a read, the other two land
    // while it is out. One trailing read covers both, and no more.
    h.refreshAllTrades();
    h.refreshAllTrades();
    h.refreshAllTrades();
    await h.advance(0);
    expect(h.reads()).toBe(3);
  });

  it("falls back to a timer while the stream is down, and drops it when the stream returns", async () => {
    const h = await streamHarness();
    await h.render(false);
    await h.advance(60_000);
    expect(h.reads()).toBe(1 + 60_000 / 5_000);

    const before = h.reads();
    await h.render(true);
    await h.advance(0);
    // The stream coming back is a read of its own — frames sent while it was
    // down are gone — and then nothing on a timer.
    expect(h.reads()).toBe(before + 1);
    await h.advance(60_000);
    expect(h.reads()).toBe(before + 1);
  });
});

describe("useTrades — tradesRead is true only once a snapshot has arrived", () => {
  // The board hides a row only when it has read the trade rows that would
  // keep it. `!loading` cannot say that: a failed first fetch ends the wait
  // with `[]`, which is *no answer*, not *no open trades*.
  it("is false before the first answer and true after it", async () => {
    const { reads, render } = await harness();

    await render("tok-1", null);

    expect(reads[0]).toBe(false);
    expect(reads.at(-1)).toBe(true);
  });

  it("stays false when the first fetch fails, though loading has ended", async () => {
    const { seen, reads, render } = await harness(() => false);

    await render("tok-1", null);

    expect(seen.at(-1)).toEqual({ trades: 0, loading: false });
    expect(reads.every((r) => r === false)).toBe(true);
  });

  it("is false again for a new scope until that scope answers", async () => {
    const { reads, render } = await harness((call) => call === 0);

    await render("tok-1", null);
    expect(reads.at(-1)).toBe(true);

    await render("tok-1", 5001);
    expect(reads.at(-1)).toBe(false);
  });

  it("stays true across a token rotation whose refetch fails — the rows on screen are still a read", async () => {
    const { seen, reads, render } = await harness((call) => call === 0);

    await render("tok-1", null);
    const before = reads.length;
    await render("tok-2", null);

    expect(reads.slice(before).every((r) => r === true)).toBe(true);
    expect(seen.at(-1)).toEqual({ trades: 2, loading: false });
  });
});
