// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TimeStepInput } from "./time-step-input";

// The rest of the suite is node-only; this file opts into a DOM because the
// defect it covers lives in the ordering between a React state update and the
// synchronous blur that `focus()` fires. Nothing below the DOM boundary can
// reproduce it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABEL = "Main session end";
const BLACKOUT_MESSAGE = "Outside allowed session window";

// Mirrors the component's unexported hold timings.
const HOLD_DELAY_MS = 400;
const HOLD_INTERVAL_MS = 100;

// A browser writes an input's value through the prototype setter. React
// installs a per-node override to detect changes, so assigning `el.value`
// directly keeps its tracker in sync and `onChange` never fires.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function mount(ui: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

function segment(kind: "hour" | "minute"): HTMLInputElement {
  const el = container!.querySelector<HTMLInputElement>(`input[aria-label="${LABEL} ${kind}"]`);
  if (!el) throw new Error(`missing ${kind} segment`);
  return el;
}

function periodButton(): HTMLButtonElement {
  const el = container!.querySelector<HTMLButtonElement>(`button[aria-label="${LABEL} period"]`);
  if (!el) throw new Error("missing period button");
  return el;
}

function stepper(direction: "Increase" | "Decrease"): HTMLButtonElement {
  const el = container!.querySelector<HTMLButtonElement>(`button[aria-label="${direction} time"]`);
  if (!el) throw new Error(`missing ${direction} stepper`);
  return el;
}

/** Mounts the component the way `param-form` does: controlled, with the parent
 *  echoing every commit back down as a fresh `value`. */
function Controlled({ initial, spy }: { initial: string; spy: (next: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <TimeStepInput
      value={value}
      ariaLabel={LABEL}
      onChange={(next) => {
        spy(next);
        setValue(next);
      }}
    />
  );
}

function render(initial: string) {
  const onChange = vi.fn();
  mount(<Controlled initial={initial} spy={onChange} />);
  return { onChange, hour: segment("hour"), minute: segment("minute"), period: periodButton() };
}

function keystroke(el: HTMLInputElement, value: string) {
  act(() => {
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Focus the segment — which selects its contents, so the first digit replaces
 *  what is there — then type one keystroke at a time. Setting the whole string
 *  in a single `input` event reproduces nothing: the defect lives in the gap
 *  between the first and second keystroke. */
function typeInto(el: HTMLInputElement, digits: string) {
  act(() => el.focus());
  let typed = "";
  for (const digit of digits) {
    typed += digit;
    keystroke(el, typed);
  }
}

function pressKey(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function blurOff(el: HTMLElement) {
  act(() => el.blur());
}

function mouseDown(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

function mouseUp(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  });
}

describe("TimeStepInput", () => {
  describe("typing", () => {
    it("keeps a two-digit hour instead of collapsing it to the first digit", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "11");
      expect(ui.hour.value).toBe("11");
      expect(ui.minute.value).toBe("30");
      expect(ui.onChange).toHaveBeenCalledTimes(1);
      expect(ui.onChange).toHaveBeenLastCalledWith("11:30");
    });

    it("keeps a two-digit minute instead of collapsing it to the first digit", () => {
      const ui = render("09:30");
      typeInto(ui.minute, "45");
      expect(ui.minute.value).toBe("45");
      expect(ui.hour.value).toBe("09");
      expect(ui.onChange).toHaveBeenCalledTimes(1);
      expect(ui.onChange).toHaveBeenLastCalledWith("09:45");
    });

    it("advances focus to the minute once the hour is complete", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "11");
      expect(document.activeElement).toBe(ui.minute);
    });

    it("advances focus to the period once the minute is complete", () => {
      const ui = render("09:30");
      typeInto(ui.minute, "45");
      expect(document.activeElement).toBe(ui.period);
    });

    it("commits an hour and a minute typed in sequence", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "11");
      typeInto(ui.minute, "45");
      expect(ui.hour.value).toBe("11");
      expect(ui.minute.value).toBe("45");
      expect(ui.onChange).toHaveBeenLastCalledWith("11:45");
    });

    it("commits a single typed digit on blur", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "1");
      blurOff(ui.hour);
      expect(ui.hour.value).toBe("01");
      expect(ui.onChange).toHaveBeenLastCalledWith("01:30");
    });

    it("reverts an hour above 12 on blur", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "13");
      blurOff(ui.hour);
      expect(ui.hour.value).toBe("09");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("reverts a zero hour on blur", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "0");
      blurOff(ui.hour);
      expect(ui.hour.value).toBe("09");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("reverts an emptied hour on blur", () => {
      const ui = render("09:30");
      act(() => ui.hour.focus());
      keystroke(ui.hour, "");
      blurOff(ui.hour);
      expect(ui.hour.value).toBe("09");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("reverts a minute above 59 on blur", () => {
      const ui = render("09:30");
      typeInto(ui.minute, "60");
      blurOff(ui.minute);
      expect(ui.minute.value).toBe("30");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("reverts the typed hour when Escape is pressed", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "1");
      pressKey(ui.hour, "Escape");
      expect(ui.hour.value).toBe("09");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("reverts the typed minute when Escape is pressed", () => {
      const ui = render("09:30");
      typeInto(ui.minute, "4");
      pressKey(ui.minute, "Escape");
      expect(ui.minute.value).toBe("30");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("commits the hour and advances when the colon key is pressed", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "4");
      pressKey(ui.hour, ":");
      expect(ui.hour.value).toBe("04");
      expect(document.activeElement).toBe(ui.minute);
      expect(ui.onChange).toHaveBeenCalledTimes(1);
      expect(ui.onChange).toHaveBeenLastCalledWith("04:30");
    });

    it("does not report a value the parent already has", () => {
      const ui = render("09:30");
      typeInto(ui.hour, "09");
      expect(ui.hour.value).toBe("09");
      expect(ui.onChange).not.toHaveBeenCalled();
    });

    it("reports nothing when a segment is focused and blurred untouched", () => {
      const ui = render("09:30");
      act(() => ui.hour.focus());
      blurOff(ui.hour);
      expect(ui.onChange).not.toHaveBeenCalled();
    });
  });

  describe("stepping", () => {
    it("steps the minute up with ArrowUp", () => {
      const ui = render("09:30");
      act(() => ui.minute.focus());
      pressKey(ui.minute, "ArrowUp");
      expect(ui.minute.value).toBe("31");
      expect(ui.onChange).toHaveBeenLastCalledWith("09:31");
    });

    it("steps the minute down with ArrowDown", () => {
      const ui = render("09:30");
      act(() => ui.minute.focus());
      pressKey(ui.minute, "ArrowDown");
      expect(ui.minute.value).toBe("29");
      expect(ui.onChange).toHaveBeenLastCalledWith("09:29");
    });

    it("steps the hour with ArrowUp", () => {
      const ui = render("09:30");
      act(() => ui.hour.focus());
      pressKey(ui.hour, "ArrowUp");
      expect(ui.hour.value).toBe("10");
      expect(ui.onChange).toHaveBeenLastCalledWith("10:30");
    });

    it("toggles the period", () => {
      const ui = render("09:30");
      act(() => ui.period.click());
      expect(ui.period.textContent).toBe("PM");
      expect(ui.onChange).toHaveBeenLastCalledWith("21:30");
    });

    // A53. The hold interval closed over the `applyStep` of the render the
    // press started in, so every repeat re-stepped from the same `parts` and
    // recomputed 09:31, which `lastCommittedRef` then swallowed: the field
    // stepped once and sat there for as long as the operator held.
    it("A53 — keeps stepping while held, and stops on release", () => {
      vi.useFakeTimers();
      const ui = render("09:30");
      const up = stepper("Increase");
      mouseDown(up);
      expect(ui.onChange).toHaveBeenLastCalledWith("09:31");
      act(() => {
        vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 3);
      });
      expect(ui.minute.value).toBe("34");
      expect(ui.onChange.mock.calls.map(([v]) => v)).toEqual(["09:31", "09:32", "09:33", "09:34"]);
      mouseUp(up);
      act(() => {
        vi.advanceTimersByTime(HOLD_INTERVAL_MS * 10);
      });
      expect(ui.onChange).toHaveBeenCalledTimes(4);
    });

    it("A53 — keeps stepping while held when the parent does not echo the value back", () => {
      vi.useFakeTimers();
      const onChange = vi.fn();
      mount(<TimeStepInput value="09:30" ariaLabel={LABEL} onChange={onChange} />);
      mouseDown(stepper("Decrease"));
      act(() => {
        vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 2);
      });
      expect(onChange.mock.calls.map(([v]) => v)).toEqual(["09:29", "09:28", "09:27"]);
      mouseUp(stepper("Decrease"));
    });

    it("clears the hold timers on unmount", () => {
      vi.useFakeTimers();
      const ui = render("09:30");
      mouseDown(stepper("Increase"));
      const callsAtPress = ui.onChange.mock.calls.length;
      act(() => root!.unmount());
      root = null;
      act(() => {
        vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_INTERVAL_MS * 10);
      });
      expect(ui.onChange).toHaveBeenCalledTimes(callsAtPress);
    });
  });

  describe("blackout range", () => {
    it("shows a typed blackout value without reporting it to the parent", () => {
      const ui = render("14:30");
      typeInto(ui.hour, "04");
      expect(ui.hour.value).toBe("04");
      expect(ui.period.textContent).toBe("PM");
      expect(ui.onChange).not.toHaveBeenCalled();
      expect(container!.textContent).toContain(BLACKOUT_MESSAGE);
    });

    it("shows a stepped blackout value without reporting it to the parent", () => {
      const ui = render("15:55");
      act(() => ui.minute.focus());
      pressKey(ui.minute, "ArrowUp");
      expect(ui.minute.value).toBe("56");
      expect(ui.onChange).not.toHaveBeenCalled();
      expect(container!.textContent).toContain(BLACKOUT_MESSAGE);
    });

    // A55: the skip walked one minute at a time with a budget of 60, and the
    // blackout is 129 minutes wide, so the walk never reached the far side and
    // the arrow did nothing at either edge.
    it("A55 — ▲ at the blackout's near edge jumps over it to the first allowed minute", () => {
      const ui = render("15:55");
      const up = stepper("Increase");
      mouseDown(up);
      mouseUp(up);
      expect(ui.hour.value).toBe("06");
      expect(ui.minute.value).toBe("05");
      expect(ui.period.textContent).toBe("PM");
      expect(ui.onChange.mock.calls.map(([v]) => v)).toEqual(["18:05"]);
    });

    it("A55 — ▼ at the blackout's far edge jumps back over it", () => {
      const ui = render("18:05");
      const down = stepper("Decrease");
      mouseDown(down);
      mouseUp(down);
      expect(ui.hour.value).toBe("03");
      expect(ui.minute.value).toBe("55");
      expect(ui.onChange.mock.calls.map(([v]) => v)).toEqual(["15:55"]);
    });
  });

  describe("external value", () => {
    it("pulls an external value change back into the segments", () => {
      const onChange = vi.fn();
      mount(<TimeStepInput value="09:30" ariaLabel={LABEL} onChange={onChange} />);
      act(() => root!.render(<TimeStepInput value="13:45" ariaLabel={LABEL} onChange={onChange} />));
      expect(segment("hour").value).toBe("01");
      expect(segment("minute").value).toBe("45");
      expect(periodButton().textContent).toBe("PM");
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
