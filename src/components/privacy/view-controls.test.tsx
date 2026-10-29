// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { COLLAPSE_ALL_LABEL, EXPAND_ALL_LABEL } from "@/components/book/book-grid-model";
import { HIDE_ACCOUNT_IDS_KEY, HIDE_BALANCES_KEY } from "./privacy-model";

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ accounts: [] }),
}));

const { PrivacyProvider } = await import("./privacy-provider");
const {
  ViewControls,
  HIDE_BALANCES_TITLE_OFF,
  HIDE_BALANCES_TITLE_ON,
  HIDE_IDS_TITLE_OFF,
  HIDE_IDS_TITLE_ON,
} = await import("./view-controls");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(el: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<PrivacyProvider>{el}</PrivacyProvider>));
}

const segments = () => Array.from(container!.querySelectorAll("button"));
const switches = () => Array.from(container!.querySelectorAll<HTMLButtonElement>("[role='switch']"));

beforeEach(() => localStorage.clear());

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ViewControls", () => {
  it("draws the fold segment then the two switches", async () => {
    await mount(<ViewControls fold={{ allOpen: false, onToggle: () => {} }} />);
    expect(segments()).toHaveLength(3);
    expect(segments()[0].getAttribute("title")).toBe(EXPAND_ALL_LABEL);
    expect(segments()[0].getAttribute("aria-label")).toBe(EXPAND_ALL_LABEL);
    expect(switches().map((s) => s.textContent)).toEqual(["ID", "$"]);
  });

  it("titles the fold segment Collapse all when every card is open, and presses through", async () => {
    const onToggle = vi.fn();
    await mount(<ViewControls fold={{ allOpen: true, onToggle }} />);
    expect(segments()[0].getAttribute("title")).toBe(COLLAPSE_ALL_LABEL);
    await act(async () => segments()[0].click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("has no fold segment without `fold`", async () => {
    await mount(<ViewControls />);
    expect(segments()).toHaveLength(2);
    expect(segments().every((b) => b.getAttribute("role") === "switch")).toBe(true);
  });

  it("aria-checked and the tooltip follow each flag, and a press is remembered", async () => {
    await mount(<ViewControls />);
    const [ids, balances] = switches();
    expect(ids.getAttribute("aria-checked")).toBe("false");
    expect(ids.title).toBe(HIDE_IDS_TITLE_OFF);
    expect(balances.getAttribute("aria-checked")).toBe("false");
    expect(balances.title).toBe(HIDE_BALANCES_TITLE_OFF);

    await act(async () => ids.click());
    expect(switches()[0].getAttribute("aria-checked")).toBe("true");
    expect(switches()[0].title).toBe(HIDE_IDS_TITLE_ON);
    expect(switches()[1].getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(HIDE_ACCOUNT_IDS_KEY)).toBe("true");

    await act(async () => switches()[1].click());
    expect(switches()[1].getAttribute("aria-checked")).toBe("true");
    expect(switches()[1].title).toBe(HIDE_BALANCES_TITLE_ON);
    expect(localStorage.getItem(HIDE_BALANCES_KEY)).toBe("true");
  });

  it("reads both flags from storage on mount", async () => {
    localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
    localStorage.setItem(HIDE_BALANCES_KEY, "true");
    await mount(<ViewControls />);
    expect(switches().map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "true"]);
  });

  it("outside the provider reads everything off rather than throwing", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<ViewControls />));
    expect(switches().map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });
});
