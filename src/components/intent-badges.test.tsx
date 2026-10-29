// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntentBadges } from "./intent-badges";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(intent: ReadonlyArray<"growth" | "speed"> | undefined) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<IntentBadges intent={intent} />));
}

describe("IntentBadges", () => {
  it('renders "Cash · growth" for a growth-admitted module', () => {
    mount(["growth"]);
    expect(container!.textContent).toBe("Cash · growth");
  });

  it('renders both shelves when a module carries both', () => {
    mount(["growth", "speed"]);
    expect(container!.textContent).toBe("Cash · growthCombine · speed");
  });

  it("renders nothing for an unlabelled module", () => {
    mount(undefined);
    expect(container!.innerHTML).toBe("");
  });

  it("renders nothing for an explicitly empty list", () => {
    mount([]);
    expect(container!.innerHTML).toBe("");
  });
});
