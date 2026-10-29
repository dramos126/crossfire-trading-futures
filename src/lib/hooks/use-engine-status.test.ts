// @vitest-environment jsdom
/**
 * The engine status reaches the browser by push. What is left of the old 5 s
 * poll is one read when a session starts, one each time the stream comes back,
 * and a timer only while the stream is down — pinned here by mounting the
 * feed against a stubbed `fetch` and a fake clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ENGINE_STATUS_FALLBACK_MS,
  applyEngineStatus,
  clearEngineStatus,
  useEngineStatus,
  useEngineStatusFeed,
  type EngineStatusBody,
} from "./use-engine-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let held: EngineStatusBody | null = null;
let answers: Array<(body: unknown) => void> = [];
let reads = 0;

function Feed({ token, live }: { token: string | null; live: boolean }) {
  useEngineStatusFeed(token, live);
  held = useEngineStatus();
  return null;
}

async function render(token: string | null, live: boolean): Promise<void> {
  root ??= createRoot(document.createElement("div"));
  await act(async () => root!.render(createElement(Feed, { token, live })));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reads = 0;
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      reads++;
      expect(url).toBe("/api/engine");
      return new Promise((resolve) => {
        answers.push((body) => resolve({ ok: true, json: async () => body }));
      });
    }),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  held = null;
  clearEngineStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useEngineStatusFeed — the stream carries it, a poll only covers a down stream", () => {
  it("reads once and arms no timer while the stream is up: a minute costs one read", async () => {
    await render("s1", true);
    await advance(60_000);
    expect(reads).toBe(1);
  });

  it("re-reads on the fallback cadence while the stream is down", async () => {
    await render("s1", false);
    await advance(ENGINE_STATUS_FALLBACK_MS * 3);
    expect(reads).toBe(4);
  });

  it("reads once more when the stream comes back, then stops", async () => {
    await render("s1", false);
    await advance(ENGINE_STATUS_FALLBACK_MS);
    expect(reads).toBe(2);

    await render("s1", true);
    expect(reads).toBe(3);
    await advance(60_000);
    expect(reads).toBe(3);
  });

  it("reads nothing without a session, and drops what it held when the session ends", async () => {
    await render("s1", true);
    await act(async () => answers.shift()!({ running: true }));
    expect(held).toEqual({ running: true });

    await render(null, true);
    await advance(60_000);
    expect(held).toBeNull();
    expect(reads).toBe(1);
  });
});

describe("the held status — a push outranks a read that was already out", () => {
  it("a frame's status replaces the copy at once", async () => {
    await render("s1", true);
    await act(async () => applyEngineStatus({ running: false }));
    expect(held).toEqual({ running: false });
  });

  it("a slow read answered after a frame does not overwrite it", async () => {
    await render("s1", true);
    await act(async () => applyEngineStatus({ running: false }));
    await act(async () => answers.shift()!({ running: true }));
    expect(held).toEqual({ running: false });
  });

  it("a frame whose status is not an object leaves the copy alone", async () => {
    await render("s1", true);
    await act(async () => applyEngineStatus({ running: true }));
    await act(async () => applyEngineStatus("garbage"));
    expect(held).toEqual({ running: true });
  });
});
