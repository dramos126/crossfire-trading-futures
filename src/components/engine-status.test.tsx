// @vitest-environment jsdom
/**
 * The `/logs` engine card reads the pushed status and keeps no poll of its
 * own: the provider's feed is the only reader of the status route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ token: "t", live: true }),
}));

const { EngineStatus } = await import("./engine-status");
const { applyEngineStatus, clearEngineStatus } = await import("@/lib/hooks/use-engine-status");

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  clearEngineStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<EngineStatus />));
}

describe("EngineStatus", () => {
  it("reads nothing on a timer — a minute mounted is zero fetches", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders what the stream pushed, and follows it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await mount();
    expect(container!.textContent).toContain("Engine …");

    await act(async () => applyEngineStatus({ running: true }));
    expect(container!.textContent).toContain("Engine Running");

    await act(async () => applyEngineStatus({ running: false }));
    expect(container!.textContent).toContain("Engine Stopped");
  });
});
