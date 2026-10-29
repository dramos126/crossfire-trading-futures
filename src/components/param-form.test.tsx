// @vitest-environment jsdom
/**
 * `visibleWhen` reads the controlling key through its schema default, so a
 * saved row that never stored the key shows the fields its default selects —
 * in all three layouts that evaluate it: a plain group, a filter group's
 * lead-in row, and a filter group's toggled row.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ParamForm } from "./param-form";
import type { ParamSchema, ParamValues } from "@/lib/trading/strategy-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(schema: Record<string, ParamSchema>, values: ParamValues): HTMLElement {
  act(() => root!.render(<ParamForm schema={schema} values={values} onChange={() => {}} />));
  return container!;
}

function unitSchema(group: string, withToggle: boolean): Record<string, ParamSchema> {
  const toggle: Record<string, ParamSchema> = withToggle
    ? { lockOn: { type: "boolean", label: "Lock", default: true, group } }
    : {};
  return {
    ...toggle,
    lockUnit: {
      type: "select",
      label: "Offset in",
      default: "ticks",
      options: [
        { value: "ticks", label: "Ticks" },
        { value: "r", label: "R" },
      ],
      group,
    },
    lockTicks: { type: "integer", label: "Offset (ticks)", default: 0, group, visibleWhen: { key: "lockUnit", value: "ticks" } },
    lockR: { type: "number", label: "Offset (R)", default: 0, group, visibleWhen: { key: "lockUnit", values: ["r"] } },
  };
}

const LAYOUTS: [string, string, boolean][] = [
  ["a plain group", "Parameters", false],
  ["a filter group's lead-in row", "Exit Filters", false],
  ["a filter group's toggled row", "Exit Filters", true],
];

describe("ParamForm visibleWhen on a sparse saved row", () => {
  it.each(LAYOUTS)("in %s, an absent controlling key reads its schema default", (_name, group, withToggle) => {
    const el = render(unitSchema(group, withToggle), {});
    expect(el.querySelector("#lockTicks")).not.toBeNull();
    expect(el.querySelector("#lockR")).toBeNull();
  });

  it.each(LAYOUTS)("in %s, a saved controlling value still wins over the default", (_name, group, withToggle) => {
    const el = render(unitSchema(group, withToggle), { lockUnit: "r" });
    expect(el.querySelector("#lockTicks")).toBeNull();
    expect(el.querySelector("#lockR")).not.toBeNull();
  });
});
