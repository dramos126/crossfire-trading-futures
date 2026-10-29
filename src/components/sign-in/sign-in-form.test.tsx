// @vitest-environment jsdom
/**
 * The sign-in form: what it sends, and the one line it shows when the answer
 * is no — in the shared words, with a lockout's wait stated plainly.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AuthFailure } from "@/lib/hooks/use-trading/auth-answer";
import { INVALID_SIGN_IN_MESSAGE } from "@/lib/auth/sign-in-wire";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const trading = vi.hoisted(() => ({
  answer: null as AuthFailure | null,
  calls: [] as Array<[string, string]>,
}));
vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({
    signIn: async (username: string, password: string) => {
      trading.calls.push([username, password]);
      return trading.answer;
    },
  }),
}));

const { SignInForm } = await import("./sign-in-form");

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  trading.calls.length = 0;
});

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SignInForm />));
}

async function typeInto(selector: string, value: string) {
  const el = container!.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function alertText(): string {
  return container!.querySelector('[role="alert"]')?.textContent ?? "";
}

describe("SignInForm", () => {
  it("sends the typed pair and clears the password on a wrong one", async () => {
    trading.answer = { kind: "invalid-sign-in" };
    await render();
    await typeInto("#sign-in-username", "operator");
    await typeInto("#sign-in-password", "not the password");
    await submit();
    expect(trading.calls).toEqual([["operator", "not the password"]]);
    expect(alertText()).toBe(INVALID_SIGN_IN_MESSAGE);
    expect(container!.querySelector<HTMLInputElement>("#sign-in-password")!.value).toBe("");
  });

  it("states a lockout's wait plainly", async () => {
    trading.answer = { kind: "rate-limited", retryAfterSeconds: 900, scope: "address" };
    await render();
    await typeInto("#sign-in-username", "operator");
    await typeInto("#sign-in-password", "whatever it is");
    await submit();
    expect(alertText()).toBe("Too many wrong sign-ins from this address. Try again in 15 minutes.");
  });

  it("shows nothing when the sign-in lands", async () => {
    trading.answer = null;
    await render();
    await typeInto("#sign-in-username", "operator");
    await typeInto("#sign-in-password", "correct horse battery");
    await submit();
    expect(alertText()).toBe("");
  });
});
