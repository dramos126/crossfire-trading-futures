/**
 * D-11's two activation prompts.
 *
 * `describeHeldPositions` is the sentence D-11 calls load-bearing: a version
 * that says only *that* the position will be closed, without saying *when*,
 * produces the outcome the whole prompt exists to prevent — the operator
 * activates at 08:00, sees nothing happen, concludes they are fine, and is
 * flattened ninety minutes later while not watching. So the three `when` arms
 * and the singular/plural agreement are pinned against the shipped string,
 * not a paraphrase.
 *
 * `D2_RULE_PROMPT` is pinned for a different reason: it is the only place the
 * operator is told what the engine will and will not touch, and it shipped
 * promising a carve-out the engine does not honour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  D2_RULE_PROMPT,
  HELD_POSITIONS_UNCHECKED_PROMPT,
  confirmActivationUnderD2,
  describeHeldPositions,
  fetchManualPositionPreview,
  type ActivationTarget,
  type ManualPositionPreview,
} from "./activation-prompts";

const TARGET: ActivationTarget = {
  accountId: 4242,
  ticker: "/MGC",
  strategyKey: "test-strategy",
  paramValues: { mainSession: { start: "09:30", end: "16:00", timezone: "America/New_York" } },
};

function preview(over: Partial<ManualPositionPreview> = {}): ManualPositionPreview {
  return {
    root: "MGC",
    inWindow: true,
    whenNy: null,
    positions: [{ contractId: "CON.F.US.MGC.G27", side: "LONG", size: 2 }],
    ...over,
  };
}

let confirmMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, ok = true): void {
  fetchMock.mockResolvedValue({ ok, json: async () => body });
}

beforeEach(() => {
  confirmMock = vi.fn(() => true);
  fetchMock = vi.fn();
  vi.stubGlobal("confirm", confirmMock);
  vi.stubGlobal("fetch", fetchMock);
  respond({ available: true, preview: preview() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeHeldPositions", () => {
  it("says immediately when the claim is already live", () => {
    const text = describeHeldPositions(preview({ inWindow: true }));
    expect(text).toContain("immediately, on the next sweep");
    expect(text).not.toContain("New York time");
  });

  it("names the wall-clock time when the window has not opened yet", () => {
    const text = describeHeldPositions(preview({ inWindow: false, whenNy: "09:30" }));
    expect(text).toContain("at 09:30 New York time");
    expect(text).not.toContain("immediately");
  });

  it("falls back to the window opening when there is no time to name", () => {
    // `whenNy` is null when no window start parsed. The sentence must still
    // say when — "will be closed" with no time is the failure D-11 names.
    const text = describeHeldPositions(preview({ inWindow: false, whenNy: null }));
    expect(text).toContain("when this deployment's session window opens");
    expect(text).not.toContain("immediately");
    expect(text).not.toContain("New York time");
  });

  it("agrees in the singular for one contract", () => {
    const text = describeHeldPositions(
      preview({ positions: [{ contractId: "CON.F.US.MGC.G27", side: "SHORT", size: 1 }] }),
    );
    expect(text).toContain("You hold 1 contract on this account");
    expect(text).not.toContain("1 contracts");
    expect(text).toContain("will close it ");
    expect(text).toContain("cancel the working orders on it.");
  });

  it("agrees in the plural for more than one", () => {
    const text = describeHeldPositions(preview());
    expect(text).toContain("You hold 2 contracts on this account");
    expect(text).toContain("will close them ");
    expect(text).toContain("cancel the working orders on them.");
  });

  it("totals across positions rather than counting rows", () => {
    // Two rows of 1 is two contracts, and reading it as "2 positions" would
    // make the plural agree for the wrong reason.
    const text = describeHeldPositions(
      preview({
        positions: [
          { contractId: "CON.F.US.MGC.G27", side: "LONG", size: 1 },
          { contractId: "CON.F.US.MGC.Z26", side: "SHORT", size: 1 },
        ],
      }),
    );
    expect(text).toContain("You hold 2 contracts");
  });

  it("lists every position with its side and size", () => {
    const text = describeHeldPositions(
      preview({
        positions: [
          { contractId: "CON.F.US.MGC.G27", side: "LONG", size: 2 },
          { contractId: "CON.F.US.MGC.Z26", side: "SHORT", size: 1 },
        ],
      }),
    );
    expect(text).toContain("CON.F.US.MGC.G27 — LONG 2");
    expect(text).toContain("CON.F.US.MGC.Z26 — SHORT 1");
  });

  it("says the warning cannot be turned off", () => {
    // Prompt 2 is the non-suppressible half of the split, and the checkbox
    // that is not built yet must never be attached to it.
    expect(describeHeldPositions(preview())).toContain("This warning cannot be turned off.");
  });
});

describe("D2_RULE_PROMPT", () => {
  it("states the in-window rule and that it spans contract months", () => {
    expect(D2_RULE_PROMPT).toContain("Active and inside its session window");
    expect(D2_RULE_PROMPT).toContain("every contract month of the same product");
  });

  it("promises the paused carve-out only, never a blanket out-of-window one", () => {
    // The engine keeps an Active deployment's resolved contract in the
    // naked-position watchdog's scope at every hour, so an unstopped hand
    // position on that exact month is flattened out of window too. The old
    // sentence — "Outside the session window, and while the deployment is
    // paused, a hand position is left alone" — promised otherwise.
    expect(D2_RULE_PROMPT).toContain("While the deployment is paused, a hand position is left alone.");
    expect(D2_RULE_PROMPT).not.toContain("Outside the session window, and while the deployment is paused");
  });

  it("names the out-of-window exception and what to do about it", () => {
    expect(D2_RULE_PROMPT).toContain("no stop-loss order covering it");
    expect(D2_RULE_PROMPT).toContain("give it a stop or put it on a different month");
  });
});

describe("confirmActivationUnderD2", () => {
  it("returns false and asks nothing further when the rule prompt is declined", async () => {
    confirmMock.mockReturnValue(false);
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the rule prompt alone when no position is held", async () => {
    respond({ available: true, preview: preview({ positions: [] }) });
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("shows the second prompt when a position is held, and honours a decline", async () => {
    confirmMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(String(confirmMock.mock.calls[1][0])).toContain("This warning cannot be turned off.");
  });

  // The session is the HttpOnly cookie, which rides the fetch on its own.
  it("sends the target and no session header", async () => {
    await confirmActivationUnderD2(TARGET);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body: string };
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toMatchObject({ accountId: 4242, ticker: "/MGC" });
  });

  // Prompt 2 is the non-suppressible one; a hand position opened since the
  // last sweep is missing from a fresh account view, so the prompt asks live.
  it("asks the preflight for a live read", async () => {
    await confirmActivationUnderD2(TARGET);
    const init = fetchMock.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ live: true });
  });
});

describe("fetchManualPositionPreview", () => {
  it("asks for the account view, not a live read, unless told to — the board strip's probe", async () => {
    await fetchManualPositionPreview(TARGET);
    const init = fetchMock.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).not.toHaveProperty("live");
  });
});

// A117: a `null` preview skipped prompt 2 exactly like an empty account, so a
// failed live read (the preflight's 500) told the operator nothing and the
// guard's next good read closed a hand position they had not been warned of.
describe("confirmActivationUnderD2 — a preflight that cannot answer shows the could-not-check prompt", () => {
  // Still a warning, not a gate: the operator's yes proceeds and nothing here
  // refuses an activation on its own — the enforcement is server-side.

  function secondPrompt(): string {
    expect(confirmMock).toHaveBeenCalledTimes(2);
    return String(confirmMock.mock.calls[1][0]);
  }

  it("A117 — a failed live read (500) shows the could-not-check prompt, and a decline stops activation", async () => {
    confirmMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    respond({ error: "Preflight failed" }, false);
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(false);
    expect(secondPrompt()).toBe(HELD_POSITIONS_UNCHECKED_PROMPT);
  });

  it("A117 — a yes to the could-not-check prompt proceeds", async () => {
    respond({ error: "Preflight failed" }, false);
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
    expect(secondPrompt()).toBe(HELD_POSITIONS_UNCHECKED_PROMPT);
  });

  it("says it could not check, that a hand position will still be closed, and that it cannot be turned off", () => {
    expect(HELD_POSITIONS_UNCHECKED_PROMPT).toContain("could not read this account's positions");
    expect(HELD_POSITIONS_UNCHECKED_PROMPT).toContain("will close it");
    expect(HELD_POSITIONS_UNCHECKED_PROMPT).toContain("once the engine can read the account");
    expect(HELD_POSITIONS_UNCHECKED_PROMPT).toContain("This warning cannot be turned off.");
  });

  it("shows it when the engine is not ready", async () => {
    respond({ available: false, preview: null });
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
    expect(secondPrompt()).toBe(HELD_POSITIONS_UNCHECKED_PROMPT);
  });

  it("shows it when the fetch itself rejects", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
    expect(secondPrompt()).toBe(HELD_POSITIONS_UNCHECKED_PROMPT);
  });

  it("shows it when the body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
    expect(secondPrompt()).toBe(HELD_POSITIONS_UNCHECKED_PROMPT);
  });

  for (const [label, body] of [
    ["a null body", null],
    ["a bare string", "nope"],
    ["available true with no preview", { available: true }],
    ["a preview that is not an object", { available: true, preview: 7 }],
    ["positions that are not an array", { available: true, preview: { root: "MGC", inWindow: true, whenNy: null, positions: "two" } }],
    ["a position row missing its size", { available: true, preview: { root: "MGC", inWindow: true, whenNy: null, positions: [{ contractId: "x", side: "LONG" }] }}],
    ["a side that is not LONG or SHORT", { available: true, preview: { root: "MGC", inWindow: true, whenNy: null, positions: [{ contractId: "x", side: "FLAT", size: 1 }] }}],
    ["inWindow as a string", { available: true, preview: { root: "MGC", inWindow: "yes", whenNy: null, positions: [] } }],
  ] as const) {
    it(`asks the could-not-check prompt on ${label} instead of throwing out of the activation`, async () => {
      // The `as` this replaced evaporated at runtime and the TypeError landed
      // in `preview.positions.length`, *outside* the try — so the activation
      // aborted with a console error and no second prompt.
      respond(body);
      await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
      expect(secondPrompt()).toBe(HELD_POSITIONS_UNCHECKED_PROMPT);
    });
  }

  it("shows prompt 2's ordinary form on a well-formed body with positions, never the could-not-check one", async () => {
    respond({ available: true, preview: preview() });
    await confirmActivationUnderD2(TARGET);
    expect(secondPrompt()).toBe(describeHeldPositions(preview()));
  });

  it("shows prompt 1 alone on an answered empty account, unchanged", async () => {
    respond({ available: true, preview: preview({ positions: [] }) });
    await expect(confirmActivationUnderD2(TARGET)).resolves.toBe(true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0][0])).toBe(D2_RULE_PROMPT);
  });
});
