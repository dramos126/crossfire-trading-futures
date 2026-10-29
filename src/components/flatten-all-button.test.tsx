// @vitest-environment jsdom
/**
 * The panic button's result says what was done. On prod a practice account on
 * the board is skipped by the route, so a bare "Done" let the operator believe
 * it was closed; the scope that used to be a stamp under the button is now its
 * title and its holding label.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  FlattenAllButton,
  flattenAllNeedsAttention,
  flattenAllResultLabel,
  toFlattenAllSummary,
  FLATTEN_ALL_LABEL,
  FLATTEN_ERROR_LABEL,
  SCOPE_LABEL,
} from "./flatten-all-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The press-and-hold length the button arms over. */
const HOLD_MS = 1500;
const PAST_PLAIN_FLASH_MS = 2500;
const PAST_RESULT_FLASH_MS = 4500;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Status = "ok" | "skipped" | "error";

function position(status: Status) {
  return { contractId: "CON.F.US.MNQ.Z26", size: 1, status };
}

interface AccountShape {
  accountId?: number;
  status: Status;
  positions?: Status[];
  cancelledOrders?: Array<"ok" | "error">;
}

function account({ accountId = 1, status, positions = [], cancelledOrders }: AccountShape) {
  return {
    accountId,
    accountName: "x",
    broker: "topstep",
    status,
    positions: positions.map(position),
    ...(cancelledOrders ? { cancelledOrders: cancelledOrders.map((s, i) => ({ orderId: i + 1, status: s })) } : {}),
  };
}

function body(...accounts: AccountShape[]) {
  return {
    ok: !accounts.some((a) => a.status === "error"),
    env: "prod",
    isProd: true,
    attempted: accounts.length,
    results: accounts.map(account),
  };
}

/** One account holding `n` positions the route closed. */
function closedAccount(n: number): AccountShape {
  return { status: "ok", positions: Array.from({ length: n }, (): Status => "ok") };
}

async function pressAndHold(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ...response })));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<FlattenAllButton token="t" />));
  const button = container.querySelector("button")!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HOLD_MS);
  });
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The route marks this account `ok` — nothing errored — while its Tradovate position was skipped and is still open. */
const UNWARMED_TRADOVATE_BODY = {
  ok: true,
  env: "prod",
  isProd: true,
  attempted: 1,
  results: [
    {
      accountId: 7,
      accountName: "x",
      broker: "tradovate",
      status: "ok",
      positions: [
        { contractId: "4393747", size: 1, status: "skipped", reason: "contract not warmed — run engine first or start market data" },
      ],
      cancelledOrders: [],
    },
  ],
};

describe("toFlattenAllSummary / flattenAllResultLabel", () => {
  it("counts positions, not accounts: a skipped position on an `ok` account is still open", () => {
    expect(toFlattenAllSummary(UNWARMED_TRADOVATE_BODY)).toEqual({
      closed: 0,
      stillOpen: 1,
      ordersMayRemain: false,
      unreached: 0,
      skippedAccounts: 0,
      attempted: 1,
    });
  });

  it("splits a partial close into what closed and what may still be open", () => {
    const summary = toFlattenAllSummary(body({ status: "error", positions: ["ok", "ok", "error"] }))!;
    expect(flattenAllResultLabel(summary)).toBe("2 closed · 1 may still be open");
  });

  it("says orders may remain when the positions closed but a cancel failed", () => {
    const summary = toFlattenAllSummary(body({ status: "error", positions: ["ok"], cancelledOrders: ["error"] }))!;
    expect(flattenAllResultLabel(summary)).toBe("1 closed · orders may remain");
  });

  it("says orders may remain for an account that errored after its sweep ran", () => {
    const summary = toFlattenAllSummary(body({ status: "error", positions: [], cancelledOrders: ["ok"] }))!;
    expect(flattenAllResultLabel(summary)).toBe("0 closed · orders may remain");
  });

  it("counts a rejected flatten's read positions as may still be open, with orders that may remain (A121)", () => {
    // The route's shape for a `flattenAccount` that rejected: the account and
    // each position it had read are `error`, and its one cancel row is an
    // `error` — the route's marker for a sweep that never ran.
    const summary = toFlattenAllSummary(body({ status: "error", positions: ["error", "error"], cancelledOrders: ["error"] }))!;
    expect(summary).toEqual({
      closed: 0,
      stillOpen: 2,
      ordersMayRemain: true,
      unreached: 0,
      skippedAccounts: 0,
      attempted: 1,
    });
    expect(flattenAllResultLabel(summary)).toBe("0 closed · 2 may still be open · orders may remain");
  });

  it("reads an error row with no positions and no sweep as not reached — its positions were never read", () => {
    // The route writes `positions: []` on an unreachable broker (accountId 0)
    // and a failed position search; "orders may remain" beside a close count
    // would read as the positions handled.
    const broker = toFlattenAllSummary(body(closedAccount(2), { accountId: 0, status: "error", positions: [] }))!;
    expect(broker).toEqual({
      closed: 2,
      stillOpen: 0,
      ordersMayRemain: false,
      unreached: 1,
      skippedAccounts: 0,
      attempted: 2,
    });
    expect(flattenAllResultLabel(broker)).toBe("2 closed · 1 account not reached — positions may be open");
    expect(flattenAllNeedsAttention(broker)).toBe(true);
    const two = toFlattenAllSummary(
      body({ accountId: 0, status: "error", positions: [] }, { status: "error", positions: [] }),
    )!;
    expect(flattenAllResultLabel(two)).toBe("0 closed · 2 accounts not reached — positions may be open");
  });

  it("reads `N closed` when everything closed, and `0 closed` when nothing was open", () => {
    expect(flattenAllResultLabel(toFlattenAllSummary(body(closedAccount(2), closedAccount(1)))!)).toBe("3 closed");
    expect(flattenAllResultLabel(toFlattenAllSummary(body({ status: "ok" }))!)).toBe("0 closed");
  });

  it("names an account the route skipped for scope — its position is untouched, and the label must say so", () => {
    const one = toFlattenAllSummary(body(closedAccount(1), { status: "skipped" }))!;
    expect(one.skippedAccounts).toBe(1);
    expect(one.stillOpen).toBe(0);
    expect(flattenAllResultLabel(one)).toBe("1 closed · 1 account skipped");
    expect(flattenAllNeedsAttention(one)).toBe(true);
    const two = toFlattenAllSummary(body(closedAccount(1), { status: "skipped" }, { status: "skipped" }))!;
    expect(flattenAllResultLabel(two)).toBe("1 closed · 2 accounts skipped");
  });

  it("does not parse a body without results, or a result or position with an unknown status", () => {
    expect(toFlattenAllSummary(null)).toBeNull();
    expect(toFlattenAllSummary({ ok: true })).toBeNull();
    expect(toFlattenAllSummary({ attempted: 1, results: [{ status: "done", positions: [] }] })).toBeNull();
    expect(toFlattenAllSummary({ attempted: 1, results: [{ accountId: 1, status: "ok" }] })).toBeNull();
    expect(
      toFlattenAllSummary({ attempted: 1, results: [{ accountId: 1, status: "ok", positions: [{ status: "done" }] }] }),
    ).toBeNull();
  });
});

describe("FlattenAllButton", () => {
  it("carries the scope sentence in its title, not under it", async () => {
    const button = await pressAndHold({ ok: true, json: async () => body(closedAccount(1)) });
    expect(button.title).toContain(SCOPE_LABEL);
    expect(container!.textContent).not.toContain(SCOPE_LABEL);
  });

  it("names itself by the scope sentence when idle, and by the result while it shows", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<FlattenAllButton token="t" />));
    const idle = container.querySelector("button")!;
    expect(idle.getAttribute("aria-label")).toContain(SCOPE_LABEL);
    await act(async () => root!.unmount());
    container.remove();
    root = null;

    const button = await pressAndHold({ ok: true, json: async () => body(closedAccount(2)) });
    expect(button.hasAttribute("aria-label")).toBe(false);
    expect(button.querySelector('[aria-live="polite"]')!.textContent).toBe("2 closed");
  });

  it("labels an all-closed result `N closed` and clears it on the short flash", async () => {
    const button = await pressAndHold({ ok: true, json: async () => body(closedAccount(2)) });
    expect(button.textContent).toContain("2 closed");
    expect(button.textContent).not.toContain("may");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_PLAIN_FLASH_MS);
    });
    expect(button.textContent).toContain(FLATTEN_ALL_LABEL);
  });

  it("labels a skipped position on an `ok` account as may still be open, held past the plain flash", async () => {
    const button = await pressAndHold({ ok: true, json: async () => UNWARMED_TRADOVATE_BODY });
    expect(button.textContent).toContain("0 closed · 1 may still be open");
    // Past the plain 2 s flash, then past the 4 s result flash.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_PLAIN_FLASH_MS);
    });
    expect(button.textContent).toContain("0 closed · 1 may still be open");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_RESULT_FLASH_MS - PAST_PLAIN_FLASH_MS);
    });
    expect(button.textContent).toContain(FLATTEN_ALL_LABEL);
  });

  it("holds `orders may remain` past the plain flash", async () => {
    const button = await pressAndHold({
      ok: true,
      json: async () => body({ status: "error", positions: ["ok"], cancelledOrders: ["error"] }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_PLAIN_FLASH_MS);
    });
    expect(button.textContent).toContain("1 closed · orders may remain");
  });

  it("labels a 2xx body that does not parse `Error`", async () => {
    const button = await pressAndHold({ ok: true, json: async () => ({ unexpected: true }) });
    expect(button.textContent).toContain(FLATTEN_ERROR_LABEL);
    expect(button.textContent).not.toContain("closed");
  });

  it("labels a non-2xx `Error`", async () => {
    const button = await pressAndHold({ ok: false, status: 500, json: async () => body(closedAccount(1)) });
    expect(button.textContent).toContain(FLATTEN_ERROR_LABEL);
  });

  it("names the scope in the visible label while holding — the only place a touch operator can read it", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<FlattenAllButton token="t" />));
    const button = container.querySelector("button")!;
    expect(button.querySelector('[aria-live="polite"]')!.textContent).toBe(FLATTEN_ALL_LABEL);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(button.querySelector('[aria-live="polite"]')!.textContent).toContain(SCOPE_LABEL);
  });

  it("neither updates nor arms the flash timer when it unmounts while the request is out", async () => {
    let resolveFetch: (r: { ok: boolean; status: number; json: () => Promise<unknown> }) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<FlattenAllButton token="t" />));
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    root = null;

    resolveFetch({ ok: true, status: 200, json: async () => body(closedAccount(1)) });
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
