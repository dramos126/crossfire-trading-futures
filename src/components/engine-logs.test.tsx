// @vitest-environment jsdom
/**
 * Display privacy on `/logs`: an account name or id inside a log line is free
 * text, so both lanes run the subject and the line itself through `text()`.
 * The decisions are `log-activity.ts`'s and `privacy-model.ts`'s, each tested
 * on its own; what only a DOM shows is that the render sites call it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WireLogRecord } from "@/lib/logging/pipe";
import { HIDE_ACCOUNT_IDS_KEY } from "@/components/privacy/privacy-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A real Topstep practice name, per the prefix table in docs/modules/brokers/topstep.md. */
const ACCOUNT = { id: 21345, name: "PRAC-V2-100200-90012114" };

const H = vi.hoisted(() => ({ live: true }));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ token: "t", accounts: [ACCOUNT], live: H.live }),
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

const { EngineLogs, LOGS_FALLBACK_MS } = await import("./engine-logs");
const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");
const { publishLogLine } = await import("@/lib/hooks/log-line-feed");

/** A line whose subject carries the account id and whose prose names the
 *  account — the shape `engine.ts`'s flatten and skip lines take. */
const LINE: WireLogRecord = {
  timestamp: new Date().toISOString(),
  deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
  level: "info",
  message: `Flatten skipped on ${ACCOUNT.name}: no open position`,
  severity: "info",
  category: "system",
  event: null,
  display: `${ACCOUNT.id}-ema-crossover.MNQ`,
  ticker: null,
  tradeId: null,
  values: null,
  burstCount: 1,
  seq: 0,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  H.live = true;
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ byLevel: { info: [LINE] } }) })),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

async function mount(lane: "activity" | "diagnostics", hideIds: boolean): Promise<string> {
  localStorage.setItem("engineLogs.lane", lane);
  if (hideIds) localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider>
        <EngineLogs />
      </PrivacyProvider>,
    );
  });
  await act(async () => {});
  return container.textContent ?? "";
}

describe("EngineLogs — lines arrive by push; a re-read only covers a down stream", () => {
  const logReads = () => vi.mocked(fetch).mock.calls.length;
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("reads once and not again in a minute while the stream is up", async () => {
    vi.useFakeTimers();
    await mount("diagnostics", false);
    await advance(60_000);
    expect(logReads()).toBe(1);
  });

  it("re-reads on the fallback cadence while the stream is down", async () => {
    H.live = false;
    vi.useFakeTimers();
    await mount("diagnostics", false);
    await advance(LOGS_FALLBACK_MS * 3);
    expect(logReads()).toBe(4);
  });

  it("re-reads once when the stream comes back, then stops", async () => {
    H.live = false;
    vi.useFakeTimers();
    await mount("diagnostics", false);
    H.live = true;
    await act(async () => {
      root!.render(
        <PrivacyProvider>
          <EngineLogs />
        </PrivacyProvider>,
      );
    });
    expect(logReads()).toBe(2);
    await advance(60_000);
    expect(logReads()).toBe(2);
  });

  it("keeps a line pushed while a read was out, when that read's snapshot predates it", async () => {
    let answer: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ ok: true, json: async () => ({ byLevel: { info: [LINE] } }) });
          }),
      ),
    );
    await mount("diagnostics", false);
    await act(async () => publishLogLine({ ...LINE, message: "pushed mid-read", seq: 1 }));
    await act(async () => answer!());
    expect(container!.textContent).toContain("pushed mid-read");
    expect(container!.textContent).toContain(LINE.message);
  });

  it("applies only the newest of two overlapping reads, so an older answer landing last wipes nothing", async () => {
    const answers: Array<(lines: WireLogRecord[]) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            answers.push((lines) => resolve({ ok: true, json: async () => ({ byLevel: { info: lines } }) }));
          }),
      ),
    );
    H.live = false;
    await mount("diagnostics", false);
    // The stream comes back: the reconnect read goes out beside the first.
    H.live = true;
    await act(async () => {
      root!.render(
        <PrivacyProvider>
          <EngineLogs />
        </PrivacyProvider>,
      );
    });
    expect(answers).toHaveLength(2);
    const [older, newer] = answers;

    await act(async () => newer([{ ...LINE, message: "in the newer snapshot", seq: 2 }]));
    await act(async () => publishLogLine({ ...LINE, message: "pushed after the newer read", seq: 3 }));
    await act(async () => older([{ ...LINE, message: "only in the older snapshot", seq: 1 }]));

    const text = container!.textContent ?? "";
    expect(text).toContain("in the newer snapshot");
    expect(text).toContain("pushed after the newer read");
    expect(text).not.toContain("only in the older snapshot");
  });

  it("renders a pushed line without a read, and a folded repeat as its climbed count", async () => {
    const text = await mount("diagnostics", false);
    expect(text).not.toContain("Bracket cancel failed");
    const pushed = { ...LINE, message: "Bracket cancel failed for order 8811001", seq: 1 };
    await act(async () => publishLogLine(pushed));
    await act(async () => publishLogLine({ ...pushed, burstCount: 4 }));
    const after = container!.textContent ?? "";
    expect(after).toContain("Bracket cancel failed for order 8811001");
    expect(after).toContain("× 4");
    expect(after.split("Bracket cancel failed").length - 1).toBe(1);
    expect(logReads()).toBe(1);
  });
});

describe.each(["activity", "diagnostics"] as const)("EngineLogs — the %s lane", (lane) => {
  it("renders the subject and the line with the alias while IDs are hidden", async () => {
    const text = await mount(lane, true);
    expect(text).toContain("Flatten skipped on Account 1: no open position");
    expect(text).toContain("Account 1-ema-crossover.MNQ");
    expect(text).not.toContain(ACCOUNT.name);
    expect(text).not.toContain(String(ACCOUNT.id));
  });

  it("renders the account as logged with the switch off", async () => {
    const text = await mount(lane, false);
    expect(text).toContain(LINE.message);
    expect(text).toContain(LINE.display);
  });
});
