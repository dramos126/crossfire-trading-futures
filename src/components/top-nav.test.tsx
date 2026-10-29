// @vitest-environment jsdom
/**
 * The phone chrome: below `sm` the tabs, Logs, the ID / $ switches and the
 * notifications toggle live in a left drawer the menu button opens. jsdom
 * applies no breakpoints, so these tests drive the drawer directly; the
 * classes that gate it to the phone are the doc's to state.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const state = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      href,
      children,
      onClick,
      ...rest
    }: {
      href: string;
      children?: unknown;
      onClick?: (e: MouseEvent) => void;
    }) =>
      createElement(
        "a",
        {
          href,
          ...rest,
          // jsdom does not navigate; the press is what the drawer answers.
          onClick: (e: MouseEvent) => {
            e.preventDefault();
            onClick?.(e);
          },
        },
        children as never,
      ),
  };
});

vi.mock("@/lib/hooks/use-system-health", () => ({
  useSystemHealth: () => ({ pillLabel: "Engine connected", pillTone: "ok", pulsing: true }),
}));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ accounts: [], token: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Fresh modules each time: the Dev entry is decided when `top-nav` loads. */
async function mountTopNav() {
  vi.resetModules();
  const { TopNav } = await import("./top-nav");
  const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <PrivacyProvider>
        <TopNav />
      </PrivacyProvider>,
    ),
  );
  return import("./top-nav");
}

const menuButton = () => container!.querySelector<HTMLButtonElement>("button[aria-controls='top-nav-drawer']")!;
// The drawer and its scrim are portalled to the body.
const drawer = () => document.getElementById("top-nav-drawer");
const scrim = () => document.querySelector<HTMLElement>("[data-top-nav-scrim]");
const drawerLinks = () => Array.from(drawer()!.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")]);
const drawerBody = () => drawer()!.children[1];
const notificationsSwitch = (scope: Element) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>("[role='switch']")).find((s) =>
    (s.getAttribute("title") ?? "").startsWith("Notifications"),
  );

async function openDrawer() {
  await act(async () => menuButton().click());
  expect(drawer()).not.toBeNull();
}

beforeEach(() => {
  state.pathname = "/";
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.style.overflow = "";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("TopNav phone drawer", () => {
  it("puts the menu button before the wordmark in the header", async () => {
    await mountTopNav();
    const header = container!.querySelector("header")!;
    const wordmark = Array.from(header.querySelectorAll("a")).find((a) => a.getAttribute("href") === "/")!;
    expect(menuButton().compareDocumentPosition(wordmark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists the four tabs and Logs, and no Dev link without dev tools", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_TOOLS_ENABLED", "");
    await mountTopNav();
    await openDrawer();
    expect(drawerLinks()).toEqual([
      ["Dashboard", "/"],
      ["Books", "/books"],
      ["Playbooks", "/playbooks"],
      ["Settings", "/settings"],
      ["Logs", "/logs"],
    ]);
  });

  it("adds the Dev link when dev tools are enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEV_TOOLS_ENABLED", "true");
    await mountTopNav();
    await openDrawer();
    expect(drawerLinks().map(([label]) => label)).toEqual(["Dashboard", "Books", "Playbooks", "Settings", "Dev", "Logs"]);
  });

  it("toggles aria-expanded and the drawer from the menu button, and closes from the drawer's close button", async () => {
    const { MENU_LABEL, CLOSE_MENU_LABEL } = await mountTopNav();
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(menuButton().getAttribute("aria-label")).toBe(MENU_LABEL);
    expect(drawer()).toBeNull();

    await openDrawer();
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(drawer()!.tagName).toBe("NAV");
    expect(drawer()!.getAttribute("aria-label")).toBe(MENU_LABEL);
    expect(drawer()!.hasAttribute("aria-modal")).toBe(false);

    await act(async () => menuButton().click());
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(drawer()).toBeNull();

    await openDrawer();
    const close = drawer()!.querySelector<HTMLButtonElement>(`button[aria-label='${CLOSE_MENU_LABEL}']`)!;
    await act(async () => close.click());
    expect(drawer()).toBeNull();
  });

  it("closes on Escape", async () => {
    await mountTopNav();
    await openDrawer();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(drawer()).toBeNull();
  });

  it("closes on a press on the scrim, and stays open on a press inside the drawer", async () => {
    await mountTopNav();
    await openDrawer();
    await act(async () => drawerBody().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(drawer()).not.toBeNull();
    await act(async () => scrim()!.click());
    expect(drawer()).toBeNull();
    expect(scrim()).toBeNull();
  });

  it("holds the body's scroll while open and releases it on close and unmount", async () => {
    await mountTopNav();
    expect(document.body.style.overflow).toBe("");
    await openDrawer();
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => scrim()!.click());
    expect(document.body.style.overflow).toBe("");

    await openDrawer();
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => root!.unmount());
    root = null;
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on a link press", async () => {
    await mountTopNav();
    await openDrawer();
    const books = Array.from(drawer()!.querySelectorAll("a")).find((a) => a.textContent === "Books")!;
    await act(async () => books.click());
    expect(drawer()).toBeNull();
  });

  it("closes when the route changes under it", async () => {
    await mountTopNav();
    await openDrawer();
    state.pathname = "/books";
    const { TopNav } = await import("./top-nav");
    const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");
    await act(async () =>
      root!.render(
        <PrivacyProvider>
          <TopNav />
        </PrivacyProvider>,
      ),
    );
    expect(drawer()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("marks the current route active in the drawer the way the tabs do", async () => {
    state.pathname = "/settings/notifications";
    await mountTopNav();
    await openDrawer();
    const settings = Array.from(drawer()!.querySelectorAll("a")).find((a) => a.textContent === "Settings")!;
    const books = Array.from(drawer()!.querySelectorAll("a")).find((a) => a.textContent === "Books")!;
    expect(settings.className).toContain("bg-[var(--active-ui-bg)]");
    expect(books.className).not.toContain("bg-[var(--active-ui-bg)]");
  });

  it("leads with the health label under its top row", async () => {
    await mountTopNav();
    await openDrawer();
    const first = drawerBody().firstElementChild!;
    expect(first.textContent).toBe("Engine connected");
    expect(first.querySelector("[aria-label='Engine connected']")).not.toBeNull();
  });

  it("flips the shared display-privacy state from its ID and $ switches", async () => {
    await mountTopNav();
    await openDrawer();
    const { HIDE_IDS_TITLE_ON, HIDE_BALANCES_TITLE_ON } = await import("@/components/privacy/view-controls");
    const { HIDE_ACCOUNT_IDS_KEY, HIDE_BALANCES_KEY } = await import("@/components/privacy/privacy-model");
    const switches = () =>
      Array.from(drawer()!.querySelectorAll<HTMLButtonElement>("[role='switch']")).filter((s) =>
        ["ID", "$"].includes(s.textContent ?? ""),
      );
    expect(switches().map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false"]);

    await act(async () => switches()[0].click());
    await act(async () => switches()[1].click());

    expect(switches().map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(switches().map((s) => s.getAttribute("title"))).toEqual([HIDE_IDS_TITLE_ON, HIDE_BALANCES_TITLE_ON]);
    expect(localStorage.getItem(HIDE_ACCOUNT_IDS_KEY)).not.toBeNull();
    expect(localStorage.getItem(HIDE_BALANCES_KEY)).not.toBeNull();
  });

  it("carries the notifications toggle without its own label, which the row already gives", async () => {
    const { NOTIFICATIONS_ROW_LABEL } = await mountTopNav();
    await openDrawer();
    const toggle = notificationsSwitch(drawer()!);
    expect(toggle).toBeDefined();
    expect(toggle!.textContent).toBe("");
    expect(toggle!.getAttribute("aria-label")).toBe("Notifications");
    expect(toggle!.closest("div")!.textContent).toBe(NOTIFICATIONS_ROW_LABEL);
  });

  it("keeps the notifications toggle's label in the desktop header by default", async () => {
    await mountTopNav();
    const toggle = notificationsSwitch(container!.querySelector("header")!);
    expect(toggle!.textContent).toBe("Notifications");
    expect(toggle!.hasAttribute("aria-label")).toBe(false);
  });
});
