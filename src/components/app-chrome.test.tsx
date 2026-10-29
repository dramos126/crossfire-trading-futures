// @vitest-environment jsdom
/**
 * The chrome and the guard on an install signed in with no broker, and on a
 * first run.
 *
 * Signed in with no broker, every page renders — the three the guard wraps
 * and Settings, which composes the chrome alone — under the no-broker line,
 * and nothing navigates: a redirect here would be the loop the chrome/guard
 * split exists to make impossible. A first run is one screen: no nav, no
 * rail, no banner. The nav, warning bar and rail are stubbed; they are not
 * under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NO_BROKER_COPY } from "@/lib/hooks/use-trading/auth-answer";

const state = vi.hoisted(() => ({
  replaced: [] as string[],
  trading: {
    status: "connected" as "connected" | "needsSetup",
    token: "session-1" as string | null,
    noBroker: true,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (href: string) => state.replaced.push(href), push: (href: string) => state.replaced.push(href) }),
  usePathname: () => "/",
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({ useTrading: () => state.trading }));
vi.mock("@/components/top-nav", () => ({ TopNav: () => <nav data-testid="top-nav" /> }));
vi.mock("@/components/system-warning-bar", () => ({ SystemWarningBar: () => null }));
vi.mock("@/components/status-rail", () => ({ StatusRail: () => <footer data-testid="status-rail" /> }));

const { AppChrome } = await import("./app-chrome");
const { AppShell } = await import("./app-shell");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(el: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
  // The guard's one read, then its render.
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  state.replaced.length = 0;
  state.trading = { status: "connected", token: "session-1", noBroker: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ setupConfirmedAt: "2026-10-29T12:00:00.000Z" }) })),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("signed in with no broker", () => {
  for (const page of ["/", "/books", "/playbooks/orb-confluence-capped"]) {
    it(`renders ${page} through the guard, under the no-broker line, with no redirect`, async () => {
      await mount(
        <AppShell>
          <p>page {page}</p>
        </AppShell>,
      );
      expect(container!.textContent).toContain(`page ${page}`);
      expect(container!.querySelector("[role='status']")?.textContent).toBe(NO_BROKER_COPY);
      expect(container!.querySelector("[role='status'] a")?.getAttribute("href")).toBe("/settings");
      expect(state.replaced).toEqual([]);
    });
  }

  it("renders Settings — the chrome without the guard — under the same line, with no redirect", async () => {
    await mount(
      <AppChrome>
        <p>settings</p>
      </AppChrome>,
    );
    expect(container!.textContent).toContain("settings");
    expect(container!.querySelector("[role='status']")?.textContent).toBe(NO_BROKER_COPY);
    expect(state.replaced).toEqual([]);
  });

  it("draws no line once the session has a broker", async () => {
    state.trading = { ...state.trading, noBroker: false };
    await mount(
      <AppChrome>
        <p>page</p>
      </AppChrome>,
    );
    expect(container!.textContent).not.toContain(NO_BROKER_COPY);
  });
});

describe("a first run", () => {
  it("is the page alone: no nav, no rail, no banner", async () => {
    state.trading = { status: "needsSetup", token: null, noBroker: false };
    await mount(
      <AppChrome>
        <p>setup</p>
      </AppChrome>,
    );
    expect(container!.textContent).toContain("setup");
    expect(container!.querySelector("[data-testid='top-nav']")).toBeNull();
    expect(container!.querySelector("[data-testid='status-rail']")).toBeNull();
    expect(container!.querySelector("[role='status']")).toBeNull();
  });
});

describe("the guard", () => {
  it("carries no path check — the page it redirects to is exempt by composition, never by name", () => {
    const src = readFileSync(join(process.cwd(), "src/components/setup-guard.tsx"), "utf8");
    expect(src).not.toMatch(/usePathname|pathname\s*[!=]==/);
  });
});
