// @vitest-environment jsdom
/**
 * The status-body parsers behind `useSystemHealth`, and the connection
 * banner it raises.
 *
 * The parsers are the half that decides what reaches state: an HTTP body is a
 * boundary, and the two fields it carries drive a danger-tone pill and a
 * warning banner that tells the operator trading has stopped. Both are
 * exported for exactly this — the alternative was a test that reimplemented
 * the narrowing and asserted its own copy. The banner's retry is a decision
 * inside the hook, so it is tested by mounting the hook.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  connectionWarning,
  DISCONNECTED_COPY,
  ENTRY_HOLD_DETAIL,
  parseMarketHub,
  parseSeamHealth,
  useSystemHealth,
  type SystemHealth,
} from "./use-system-health";
import {
  BROKER_NOT_CONFIGURED_COPY,
  BROKER_REFUSED_COPY,
  UNREACHABLE_COPY,
  authFailureCopy,
  readAuthAnswer,
} from "@/lib/hooks/use-trading/auth-answer";
import { INVALID_SIGN_IN_MESSAGE } from "@/lib/auth/sign-in-wire";
import { applyEngineStatus, clearEngineStatus } from "@/lib/hooks/use-engine-status";
import type { EntryHoldReason as EngineEntryHoldReason } from "@/lib/trading/engine/engine-health";

const trading = vi.hoisted(() => ({
  value: {
    status: "error" as string,
    error: "Topstep /api/Auth/loginKey 401: {\"errorCode\":3}" as string | null,
    errorKind: "broker-refused" as string | null,
    token: null as string | null,
    live: false,
    connect: async () => {},
  },
}));
vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({ useTrading: () => trading.value }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("parseMarketHub", () => {
  it("accepts a well-formed hub status", () => {
    expect(
      parseMarketHub({ mode: "passive", autoRetry: true, lastDisconnectReason: "kicked" }),
    ).toEqual({ mode: "passive", autoRetry: true, lastDisconnectReason: "kicked" });
  });

  it("rejects a mode outside the two the engine publishes", () => {
    expect(parseMarketHub({ mode: "degraded" })).toBeNull();
  });

  it("rejects a non-object body rather than casting it", () => {
    expect(parseMarketHub(null)).toBeNull();
    expect(parseMarketHub("realtime")).toBeNull();
  });

  it("reads a non-boolean autoRetry as false rather than as truthy", () => {
    // `autoRetry: false` is what puts "manual reconnect" in front of the
    // operator, so a string here must not become `true` by coercion.
    expect(parseMarketHub({ mode: "passive", autoRetry: "no" })?.autoRetry).toBe(false);
  });
});

describe("parseSeamHealth", () => {
  const body = {
    marketData: { realtime: { state: "down", reason: "bar reads failing for 300s" } },
    degraded: true,
    frozen: ["entries", "strategy exits"],
    entriesHeld: null,
  };

  it("accepts a well-formed seam-health body", () => {
    expect(parseSeamHealth(body)).toEqual(body);
  });

  it("rejects a state outside the ladder", () => {
    // A pill tone and a banner hang off this value; an unrecognised state must
    // not reach them wearing the `MarketDataState` type.
    expect(parseSeamHealth({ ...body, marketData: { realtime: { state: "offline" } } })).toBeNull();
  });

  it("rejects a body with no market-data slot at all", () => {
    expect(parseSeamHealth({ degraded: true, frozen: [] })).toBeNull();
    expect(parseSeamHealth({ marketData: {}, degraded: true })).toBeNull();
  });

  it("drops non-string entries from the frozen list instead of rendering them", () => {
    expect(parseSeamHealth({ ...body, frozen: ["entries", 7, null] })?.frozen).toEqual(["entries"]);
  });

  it("reads a missing frozen list as empty and a missing degraded as false", () => {
    const parsed = parseSeamHealth({ marketData: { realtime: { state: "healthy" } } });
    expect(parsed).toEqual({
      marketData: { realtime: { state: "healthy", reason: null } },
      degraded: false,
      frozen: [],
      entriesHeld: null,
    });
  });

  it("carries both entry holds through, and nothing else", () => {
    // The pill's warn arm hangs off this value. An unrecognised reason must
    // read as "not held" rather than reach the switch that picks the copy —
    // the same rule the state ladder above follows.
    expect(parseSeamHealth({ ...body, entriesHeld: "post-outage-bar" })?.entriesHeld).toBe(
      "post-outage-bar",
    );
    expect(parseSeamHealth({ ...body, entriesHeld: "flap-breaker" })?.entriesHeld).toBe(
      "flap-breaker",
    );
    expect(parseSeamHealth({ ...body, entriesHeld: "paused" })?.entriesHeld).toBeNull();
  });

  it("carries the hold every start stamps, so the pill says Entries Held rather than Connected", () => {
    expect(parseSeamHealth({ ...body, entriesHeld: "post-start-bar" })?.entriesHeld).toBe(
      "post-start-bar",
    );
    expect(ENTRY_HOLD_DETAIL["post-start-bar"]).toBe("waiting for a bar after the engine started");
  });

  it("has a detail line for every reason the engine reports", () => {
    // A type-level check: a fourth `EntryHoldReason` on the engine fails to
    // compile here until the dashboard learns its sentence.
    const everyReason: Record<EngineEntryHoldReason, string> = ENTRY_HOLD_DETAIL;
    for (const reason of Object.keys(everyReason)) {
      expect(parseSeamHealth({ ...body, entriesHeld: reason })?.entriesHeld).toBe(reason);
    }
  });
});

describe("the banner's words — operator copy, never the server's text", () => {
  it("maps each way /api/auth fails to its sentence", () => {
    const failureOf = (status: number, body: unknown) => {
      const answer = readAuthAnswer(status, body);
      if (answer.kind !== "failed") throw new Error(`expected a failure, got ${answer.kind}`);
      return authFailureCopy(answer.failure);
    };
    expect(failureOf(401, { invalidSignIn: true, error: "x" })).toBe(INVALID_SIGN_IN_MESSAGE);
    expect(failureOf(429, { rateLimited: true, retryAfterSeconds: 840 })).toBe(
      "Too many wrong sign-ins from this address. Try again in 14 minutes.",
    );
    expect(failureOf(429, { rateLimited: true, retryAfterSeconds: 45 })).toMatch(/in 45 seconds\.$/);
    expect(failureOf(500, { error: "Missing TOPSTEP_USERNAME or TOPSTEP_API_KEY" })).toBe(
      BROKER_NOT_CONFIGURED_COPY,
    );
    expect(failureOf(401, { error: "Tradovate authentication failed" })).toBe(BROKER_REFUSED_COPY);
    expect(failureOf(502, null)).toBe(UNREACHABLE_COPY);
  });

  it("an error banner carries the mapped sentence, not the raw error", () => {
    const warning = connectionWarning({
      status: "error",
      errorKind: "broker-refused",
      retrying: false,
      onRetry: async () => {},
    });
    expect(warning?.message).toBe(BROKER_REFUSED_COPY);
    expect(warning?.message).not.toContain("loginKey");
  });

  it("a network failure reads as the server being unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const { postAuth } = await import("@/lib/hooks/use-trading/auth-answer");
    const answer = await postAuth();
    vi.unstubAllGlobals();
    expect(answer.kind === "failed" && authFailureCopy(answer.failure)).toBe(UNREACHABLE_COPY);
  });
});

describe("the banner's retry — busy while the connect it started is in flight", () => {
  let root: Root | null = null;
  let latest: SystemHealth | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    latest = null;
  });

  function Probe() {
    latest = useSystemHealth();
    return null;
  }

  async function mount(): Promise<void> {
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(createElement(Probe)));
  }

  for (const [status, errorKind, message] of [
    ["error", "broker-refused", BROKER_REFUSED_COPY],
    ["disconnected", null, DISCONNECTED_COPY],
  ] as const) {
    it(`${status}: the button disables and says it is working until connect settles`, async () => {
      let release: () => void = () => {};
      const connect = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            // What the real connect does first: the status leaves error.
            trading.value = { ...trading.value, status: "connecting" };
            release = resolve;
          }),
      );
      trading.value = { ...trading.value, status, errorKind, connect };
      await mount();
      expect(latest?.warning).toMatchObject({ message, busy: false });

      await act(async () => {
        void latest?.warning?.onAction();
      });
      await act(async () => root!.render(createElement(Probe)));
      expect(connect).toHaveBeenCalledTimes(1);
      // Still up, and busy, though the status is `connecting`.
      expect(latest?.warning).toMatchObject({ message, busy: true });

      // A second press while busy does not start a second connect.
      await act(async () => {
        void latest?.warning?.onAction();
      });
      expect(connect).toHaveBeenCalledTimes(1);

      trading.value = { ...trading.value, status, errorKind };
      await act(async () => release());
      await act(async () => root!.render(createElement(Probe)));
      expect(latest?.warning).toMatchObject({ busy: false });
    });
  }
});

describe("the pill reads the pushed status and polls nothing of its own", () => {
  let root: Root | null = null;
  let latest: SystemHealth | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    latest = null;
    clearEngineStatus();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function Probe() {
    latest = useSystemHealth();
    return null;
  }

  it("goes No Market Data on a degraded frame, with zero fetches in a minute", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    trading.value = { ...trading.value, status: "connected", errorKind: null, token: "s1", live: true };
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(createElement(Probe)));
    await act(async () =>
      applyEngineStatus({
        running: true,
        marketHub: { mode: "realtime", autoRetry: true, lastDisconnectReason: null },
        health: { marketData: { realtime: { state: "down", reason: "bar reads failing" } }, degraded: true, frozen: ["entries"] },
      }),
    );
    expect(latest).toMatchObject({ pillLabel: "No Market Data", pillTone: "danger" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
