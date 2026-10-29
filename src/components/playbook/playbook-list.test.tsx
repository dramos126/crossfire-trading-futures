// @vitest-environment jsdom
/**
 * The Playbooks list's phone layout (below `sm`). jsdom applies no media
 * query, so what is pinned is the markup that makes the layout: which copy
 * carries `sm:hidden` and which `hidden sm:…`, and the DOM order of the
 * phone's lines. The registry is mocked to one module declaring every stamp
 * the row can carry, so each lands on the phone line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StrategyModule } from "@/lib/trading/strategy-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "phone-fixture-playbook";
const NAME = "Phone Fixture Breakout";
const DESCRIPTION = "Buys the first close above the morning range and holds to the close.";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/lib/trading/strategies", () => ({
  listStrategies: () => [
    {
      key: KEY,
      module: {
        version: "1.0.0",
        isTest: true,
        config: {
          name: NAME,
          description: DESCRIPTION,
          timeframe: "5m",
          session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
          entryType: 2,
          indicators: [],
          calibratedFor: "MNQ",
          fixedStopTicks: 400,
          intent: ["growth"],
          admission: { status: "candidate", decidedOn: "2026-10-01" },
        },
        params: {},
        shouldEnter: () => null,
        shouldExit: () => false,
      } as unknown as StrategyModule,
    },
  ],
}));

const { PlaybookList } = await import("./playbook-list");

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<PlaybookList />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function classesOf(el: Element | null | undefined): string[] {
  return el?.className.split(/\s+/) ?? [];
}

function row(): HTMLAnchorElement {
  return container.querySelector<HTMLAnchorElement>(`a[href="/playbooks/${KEY}"]`)!;
}

function spanSaying(text: string): HTMLElement[] {
  return Array.from(row().querySelectorAll<HTMLElement>("span")).filter((s) => s.textContent === text);
}

function follows(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("the Playbooks list on a phone", () => {
  it("keeps the whole row one link", () => {
    expect(row()).not.toBeNull();
    expect(row().querySelector("h3")?.textContent).toBe(NAME);
  });

  it("hides the key below sm and shows it inline from sm", () => {
    const [key] = spanSaying(KEY);
    expect(classesOf(key)).toEqual(expect.arrayContaining(["hidden", "sm:inline"]));
  });

  it("still finds a playbook by its key in the search", async () => {
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search playbooks"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(search, "phone-fixture");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(row()).not.toBeNull();
  });

  it("draws the title line's stamps only from sm, leaving the name alone on a phone", () => {
    const title = row().querySelector("h3")!.parentElement!;
    const extras = Array.from(title.children).filter((c) => c.tagName !== "H3");
    for (const el of extras) expect(classesOf(el)).toContain("hidden");
  });

  it("puts the instrument, bar and session chips, then every stamp, on one phone line before the description", () => {
    const phone = Array.from(row().querySelectorAll("div")).find((d) => classesOf(d).includes("sm:hidden"))!;
    const labels = Array.from(phone.children).map((c) => c.textContent);
    expect(labels.slice(0, 3)).toEqual(["MNQ", "5 Minutes", "09:30–15:55 ET"]);
    expect(phone.textContent).toContain("CANDIDATE");
    expect(phone.textContent).toContain("test fixture");
    expect(phone.textContent).toContain("in no book");
    expect(phone.textContent).toMatch(/needs \$\d+ risk\/trade/);

    const description = Array.from(row().querySelectorAll("p")).find((p) => p.textContent === DESCRIPTION)!;
    expect(follows(row().querySelector("h3")!, phone)).toBe(true);
    expect(follows(phone, description)).toBe(true);
  });

  it("sets the description at text-sm with relaxed leading on a phone and text-xs from sm", () => {
    const description = Array.from(row().querySelectorAll("p")).find((p) => p.textContent === DESCRIPTION)!;
    expect(classesOf(description)).toEqual(
      expect.arrayContaining(["text-sm", "leading-relaxed", "sm:text-xs"]),
    );
  });

  it("keeps the desk chip line under the description, from sm only", () => {
    const desk = Array.from(row().querySelectorAll("div")).find((d) => classesOf(d).includes("sm:flex"))!;
    expect(classesOf(desk)).toContain("hidden");
    const description = Array.from(row().querySelectorAll("p")).find((p) => p.textContent === DESCRIPTION)!;
    expect(follows(description, desk)).toBe(true);
    expect(desk.textContent).toContain("MNQ");
  });

  it("makes the search field 44px tall below sm and its desk height from sm", () => {
    const search = container.querySelector('input[aria-label="Search playbooks"]');
    expect(classesOf(search)).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-0"]));
  });
});
