// @vitest-environment jsdom
/**
 * A select whose schema allows one value renders as text in `ParamForm`, and
 * the same param with a second value is a select again — decided by the
 * option count alone, so no playbook's key list is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ParamForm } from "./param-form";
import { FIXED_CHOICE_NOTE, FIXED_CHOICE_TITLE } from "./fixed-choice-field";
import type { ParamSchema, ParamValues, SelectParam } from "@/lib/trading/strategy-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ONE: SelectParam = {
  type: "select",
  label: "Last break (ET)",
  default: "11:00",
  options: [{ value: "11:00", label: "11:00 ET" }],
};
const TWO: SelectParam = {
  type: "select",
  label: "Range length",
  default: "15",
  options: [
    { value: "15", label: "15 minutes" },
    { value: "30", label: "30 minutes" },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(schema: Record<string, ParamSchema>, values: ParamValues = {}): HTMLElement {
  act(() => root!.render(<ParamForm schema={schema} values={values} onChange={() => {}} />));
  return container!;
}

describe("ParamForm on a one-value select", () => {
  it("renders the value as text with the note, and no select", () => {
    const el = render({ fixed: ONE, open: TWO });
    const fixed = el.querySelector("#fixed");
    expect(fixed).toBeInstanceOf(HTMLOutputElement);
    expect(fixed!.textContent).toBe("11:00 ET");
    expect(fixed!.parentElement!.textContent).toContain(FIXED_CHOICE_NOTE);
    expect(fixed!.parentElement!.getAttribute("title")).toBe(FIXED_CHOICE_TITLE);
    expect(el.querySelector('label[for="fixed"]')?.textContent).toContain("Last break (ET)");

    const open = el.querySelector("#open");
    expect(open).toBeInstanceOf(HTMLSelectElement);
    expect([...(open as HTMLSelectElement).options].map((o) => o.value)).toEqual(["15", "30"]);
    expect(el.querySelectorAll("select")).toHaveLength(1);
  });

  it("becomes a select the moment its options gain a value", () => {
    const widened: SelectParam = { ...ONE, options: [...ONE.options, { value: "11:30", label: "11:30 ET" }] };
    const el = render({ fixed: widened });
    const control = el.querySelector("#fixed");
    expect(control).toBeInstanceOf(HTMLSelectElement);
    expect([...(control as HTMLSelectElement).options].map((o) => o.value)).toEqual(["11:00", "11:30"]);
    expect(el.textContent).not.toContain(FIXED_CHOICE_NOTE);
  });

  it("prints the value it holds when that value is not the one option", () => {
    const el = render({ fixed: ONE }, { fixed: "10:30" });
    expect(el.querySelector("#fixed")!.textContent).toBe("10:30");
  });
});
