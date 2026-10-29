// @vitest-environment jsdom
/**
 * The browser's copy of the engine's setup readings. The decisions are what an
 * answer, a failure and an end of stream leave behind, so the real hook is
 * mounted and every assertion is on what it hands a render.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  clearSetupReadings,
  parseSetupReadings,
  refreshSetupReadings,
  useSetupReadings,
} from "./use-setup-readings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = "Range 21,410–21,452 set · waiting on a 5m close past either side.";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const seen: { current: ReadonlyMap<string, string> | null } = { current: null };

function Harness() {
  seen.current = useSetupReadings();
  return null;
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness)));
}

/** A status route whose answers the test releases one by one, in any order. */
function parkedStatusRoute() {
  const parked: Array<(body: unknown) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          parked.push((body) => resolve({ ok: true, json: async () => body }));
        }),
    ),
  );
  return parked;
}

afterEach(() => {
  act(() => clearSetupReadings());
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("parseSetupReadings", () => {
  it("keeps string notes by deployment id and drops anything else", () => {
    expect(parseSetupReadings({ a: NOTE, b: 3, c: " " })).toEqual(new Map([["a", NOTE]]));
    expect(parseSetupReadings({})).toEqual(new Map());
  });

  it("answers null for a field that is not a map", () => {
    expect(parseSetupReadings(undefined)).toBeNull();
    expect(parseSetupReadings([NOTE])).toBeNull();
    expect(parseSetupReadings("x")).toBeNull();
  });
});

describe("useSetupReadings", () => {
  it("is unread until a read lands, then hands back the map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ running: true, setups: { "dep-1": NOTE } }) })),
    );
    mount();
    expect(seen.current).toBeNull();

    await act(() => refreshSetupReadings());

    expect(seen.current).toEqual(new Map([["dep-1", NOTE]]));
  });

  it("goes back to unread on a failed or malformed read, never keeping the last map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ setups: { "dep-1": NOTE } }) })),
    );
    mount();
    await act(() => refreshSetupReadings());
    expect(seen.current).not.toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await act(() => refreshSetupReadings());
    expect(seen.current).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ running: true }) })));
    await act(() => refreshSetupReadings());
    expect(seen.current).toBeNull();
  });

  it("lets the newest read win when an older answer lands after it", async () => {
    const parked = parkedStatusRoute();
    mount();
    let older: Promise<void> = Promise.resolve();
    let newer: Promise<void> = Promise.resolve();
    act(() => {
      older = refreshSetupReadings();
      newer = refreshSetupReadings();
    });

    await act(async () => {
      parked[1]({ setups: { "dep-1": NOTE } });
      await newer;
    });
    await act(async () => {
      parked[0]({ setups: {} });
      await older;
    });

    expect(seen.current).toEqual(new Map([["dep-1", NOTE]]));
  });

  it("drops to unread when the stream ends, and a read still out cannot bring it back", async () => {
    const parked = parkedStatusRoute();
    mount();
    let read: Promise<void> = Promise.resolve();
    act(() => {
      read = refreshSetupReadings();
    });

    act(() => clearSetupReadings());
    await act(async () => {
      parked[0]({ setups: { "dep-1": NOTE } });
      await read;
    });

    expect(seen.current).toBeNull();
  });
});
