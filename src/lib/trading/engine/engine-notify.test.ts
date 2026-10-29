/**
 * `resolveExitReason` decides the code persisted to
 * `strategy_trades.exit_reason_code` and renders the label beside it.
 * The chip, the SQL sweep and the embed all key on that code now, so a
 * reordered branch or a retuned threshold here is still a silent
 * data-correctness bug that surfaces in trade history weeks later rather
 * than as a crash — the labels stay pinned as values, deliberately, so a
 * table edit that changes what an operator reads has to change a test.
 *
 * D1 extracted this function; these are the tests the extraction made
 * possible, per the rule in docs/proposals/engine-decomposition.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// `engine-notify` imports `getDeployment` for the two embed builders, which
// drags `db/deployments` → the strategy loader → `require.context`, a
// bundler mechanism with no vitest equivalent (patterns.md). `resolveExitReason`
// touches none of it, so cut the chain at the DB module rather than the
// registry — the registry is not on this path.
vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(() => null),
}));

// Second path to the same loader: `resolveTimeframeLabel` imports
// `getStrategy` directly. Both have to be cut — mocking one leaves the
// other pulling `require.context` in.
vi.mock("../strategies", () => ({
  getStrategy: vi.fn(() => undefined),
}));

// Only the sender is cut. The colours, the ANSI helpers and
// `formatAccountLabel` are the shipped ones, because the entry embed's
// headline is what the partial-fill test below reads.
const { sendDiscordAlertMock } = vi.hoisted(() => ({
  sendDiscordAlertMock: vi.fn<(embed: { title: string; description: string }) => Promise<void>>(
    async () => {},
  ),
}));
vi.mock("@/lib/notify/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/discord")>()),
  sendDiscordAlert: sendDiscordAlertMock,
}));

import {
  exitReasonColor,
  exitReasonEmoji,
  notifyEntry,
  resolveExitReason,
  type NotifyDeps,
} from "./engine-notify";
import { entryFillValues } from "./engine-fill-format";
import { COLOR_EXIT_LOSS, COLOR_EXIT_MANUAL } from "@/lib/notify/discord";
import {
  EXIT_REASON_BRACKET_MANUAL,
  type ExitReasonCode,
} from "@/lib/logging/exit-reasons";

type LogFn = NotifyDeps["log"];

/** The two halves of a resolution, so an assertion reads as one line. The
 *  code is the owner; the label is what an operator sees. */
const label = (...args: Parameters<typeof resolveExitReason>): string =>
  resolveExitReason(...args).label;
const code = (...args: Parameters<typeof resolveExitReason>): ExitReasonCode =>
  resolveExitReason(...args).code;

function deps(): NotifyDeps & { log: LogFn & ReturnType<typeof vi.fn> } {
  const log = vi.fn() as LogFn & ReturnType<typeof vi.fn>;
  return { accountNames: new Map(), log };
}

/** Long, entry 100, 1-tick — so `slCurrentPrice` reads directly as ticks of
 *  offset from entry and the boundary cases below are legible. */
function slCtx(over: Partial<NonNullable<Parameters<typeof resolveExitReason>[3]>> = {}) {
  return {
    side: 0 as const,
    entryPrice: 100,
    slMovedToBe: false,
    slTrailEngaged: false,
    slCurrentPrice: null,
    tickSize: 1,
    ...over,
  };
}

describe("formatExitReason — bracket kind wins first", () => {
  it("labels a take-profit fill before consulting anything else", () => {
    expect(label(deps(), "tp", "strategy_signal")).toBe("Take Profit");
  });
});

describe("formatExitReason — stop-loss labels come from flags, not geometry", () => {
  // The 2026-05-02 Decision in engine.md: flags are authoritative, offset
  // arithmetic is only a drift detector. Trail beats breakeven because a
  // trail ratchet implies the stop already passed through breakeven.
  it("prefers trail over breakeven when both flags are set", () => {
    const ctx = slCtx({ slMovedToBe: true, slTrailEngaged: true });
    expect(label(deps(), "sl", null, ctx)).toBe("Trail Stop");
  });

  it("labels breakeven from the flag alone", () => {
    expect(label(deps(), "sl", null, slCtx({ slMovedToBe: true }))).toBe(
      "Breakeven Stop",
    );
  });

  it("labels a plain stop when a context exists with neither flag", () => {
    expect(label(deps(), "sl", null, slCtx())).toBe("Stop Loss");
  });

  it("falls back to a plain stop when there is no context at all", () => {
    expect(label(deps(), "sl", null, null)).toBe("Stop Loss");
  });
});

describe("formatExitReason's offset fallback is unreachable — a flagless row is a plain Stop Loss", () => {
  // Decided, not just pinned: a row predating the flags is indistinguishable
  // from a plain stop (the columns default to 0), and geometry classifying
  // it is the stale-mirror bucketing the flags replaced. The offset only
  // ever feeds the drift warning.
  const flagless = (slCurrentPrice: number, over = {}) =>
    label(deps(), "sl", null, { ...slCtx({ slCurrentPrice }), ...over });

  it("warns, rather than relabels, when a flagless stop sat past the trail offset", () => {
    const d = deps();
    expect(label(d, "sl", null, slCtx({ slCurrentPrice: 111 }))).toBe("Stop Loss");
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log.mock.calls[0][1]).toBe("warn");
  });

  it.each([
    [90, "below entry"],
    [105, "inside the legacy trail offset"],
    [110, "exactly at the offset cap"],
    [111, "one tick past the cap"],
  ])("labels a flagless stop at %d (%s) as a plain Stop Loss", (price) => {
    expect(flagless(price)).toBe("Stop Loss");
  });

  it("labels a flagless short the same way, direction notwithstanding", () => {
    expect(flagless(90, { side: 1 as const })).toBe("Stop Loss");
  });
});

describe("formatExitReason — the drift detector", () => {
  it("returns the flag label and warns when the offset disagrees", () => {
    const d = deps();
    const ctx = slCtx({ slMovedToBe: true, slCurrentPrice: 111, tradeId: 42 });

    expect(label(d, "sl", null, ctx)).toBe("Breakeven Stop");
    expect(d.log).toHaveBeenCalledTimes(1);
    const [, severity, , message] = d.log.mock.calls[0];
    expect(severity).toBe("warn");
    expect(message).toContain("drift");
    expect(message).toContain("#42");
  });

  it("stays quiet when flags and offset agree", () => {
    const d = deps();
    resolveExitReason(d, "sl", null, slCtx({ slMovedToBe: true, slCurrentPrice: 105 }));
    expect(d.log).not.toHaveBeenCalled();
  });
});

describe("resolveExitReason — engine reasons", () => {
  it.each([
    ["strategy_signal", "Strategy Exit"],
    // Pins the fall-through the D1 cleanup folded: these two arms must
    // stay identical.
    ["realtime_exit", "Strategy Exit"],
    ["trail_stop", "Trail Stop"],
    ["time_stop", "Strategy Exit · Time Stop"],
    ["ema_exit", "Strategy Exit · EMA Close-Through"],
    ["time_window_close", "Time Window Close"],
    ["bracket_failure_force_close", "Force Close (bracket failure)"],
    ["deployment_close", "Deployment Close"],
    ["engine_downtime", "Engine Downtime"],
    ["manual", "Manual"],
    // Was falling through to the residual arm until L2: the panic button
    // wrote `"Flatten All"` into the code slot and nothing recognised it.
    ["flatten_all", "Flatten All"],
    // Unreachable while D-2 passes `activeTradeId: null`, and in the table
    // so that it stops being a trap if that ever changes.
    ["manual_position_close", "Hand Position Close"],
  ])("labels %s as %s", (reason, expected) => {
    expect(label(deps(), "other", reason)).toBe(expected);
  });

  it("carries the submitted code through unchanged, which is what SQL matches", () => {
    expect(code(deps(), "other", "deployment_close")).toBe("deployment_close");
    expect(code(deps(), "other", "strategy_signal:MACD Cross")).toBe("strategy_signal");
  });

  it.each(["strategy_signal", "realtime_exit"])(
    "appends the detail suffix on a %s: prefix",
    (prefix) => {
      expect(label(deps(), "other", `${prefix}:MACD Cross`)).toBe(
        "Strategy Exit · MACD Cross",
      );
    },
  );

  it.each(["strategy_signal", "realtime_exit"])(
    "drops the separator when %s: carries an empty detail",
    (prefix) => {
      expect(label(deps(), "other", `${prefix}:`)).toBe("Strategy Exit");
    },
  );
});

describe("embed rendering — an incident close is not an operator flatten", () => {
  // `Engine Downtime` is the one exit nobody asked for: the position went
  // unmanaged past D-13's duration rule and the next boot closed it. Rendering
  // it with ✋ and the operator-flatten stripe tells an operator scanning
  // Discord that somebody flattened it by hand, which is the reading that
  // stops the investigation.
  it("does not colour an engine-downtime close like a hand flatten", () => {
    expect(exitReasonColor("engine_downtime")).not.toBe(COLOR_EXIT_MANUAL);
  });

  it("gives it the loss colour the boot alert for the same event already uses", () => {
    expect(exitReasonColor("engine_downtime")).toBe(COLOR_EXIT_LOSS);
  });

  it("does not prefix it with the hand emoji", () => {
    expect(exitReasonEmoji("engine_downtime")).not.toBe("✋");
  });

  it("still marks it, rather than dropping to the unlabelled fallback", () => {
    expect(exitReasonEmoji("engine_downtime")).toBe("🚨");
  });

  it.each<ExitReasonCode>(["manual", "deployment_close", "bracket_failure_force_close"])(
    "leaves %s on the operator-flatten stripe and emoji",
    (reasonCode) => {
      // The negatives above are only evidence beside these: the manual arm
      // still has to classify the three reasons it was built for.
      expect(exitReasonColor(reasonCode)).toBe(COLOR_EXIT_MANUAL);
      expect(exitReasonEmoji(reasonCode)).toBe("✋");
    },
  );
});

describe("resolveExitReason — the residual arm", () => {
  // `bracket_manual` is bound as a SQL parameter in db/trades.ts to drive
  // the relabel sweep. It is the one value the sweep looks for, and it is
  // reached from here.
  it.each([null, "", "something_the_engine_never_emits"])(
    "falls back to the residual reason for %j",
    (reason) => {
      expect(code(deps(), "other", reason)).toBe(EXIT_REASON_BRACKET_MANUAL);
      expect(label(deps(), "other", reason)).toBe("Bracket/Manual");
    },
  );
});

/**
 * The embed's headline names a quantity, and it has to be the same one the
 * Activity sentence names — that coupling is why the fill formatters were
 * hoisted in the first place. A partial fill is where the two can come
 * apart: the row says 2, the broker filled 1.
 */
describe("notifyEntry — the size it claims", () => {
  const TRADE = {
    id: 7,
    deploymentId: "dep-1",
    strategyKey: "ema-crossover",
    accountId: 11224469,
    ticker: "MNQ",
    side: 0 as const,
    size: 2,
    tickSize: 0.25,
    tickValue: 0.5,
    desiredTpTicks: 400,
    desiredSlTicks: 200,
    desiredEntryPrice: 29246.25,
  };

  beforeEach(() => {
    sendDiscordAlertMock.mockClear();
  });

  it("titles a partial fill with the broker size, not the submitted one", async () => {
    await notifyEntry(deps(), TRADE, 29246.25, "2026-08-27T13:00:00Z", 1);
    expect(sendDiscordAlertMock.mock.calls[0][0].title).toBe("LONG MNQ · 1 contract");
    // The lane's sentence reads off the same number, from the same default.
    expect(entryFillValues(TRADE, 29246.25, 1).size).toBe(1);
  });

  it("sizes the risk line off the fill too, which is the number under the headline", async () => {
    // `riskDollars = slTicks × tickValue × filledSize`. The title moving and
    // the body not would be the same disagreement one line down: 200 × 0.5 ×
    // 1, against the 200 the submitted 2 lots would claim.
    await notifyEntry(deps(), TRADE, 29246.25, "2026-08-27T13:00:00Z", 1);
    expect(sendDiscordAlertMock.mock.calls[0][0].description).toContain("Risk     $100.00");
  });

  it("falls back to the row's size when no fill quantity is in hand", async () => {
    await notifyEntry(deps(), TRADE, 29246.25, "2026-08-27T13:00:00Z");
    expect(sendDiscordAlertMock.mock.calls[0][0].title).toBe("LONG MNQ · 2 contracts");
    expect(entryFillValues(TRADE, 29246.25).size).toBe(2);
    expect(sendDiscordAlertMock.mock.calls[0][0].description).toContain("Risk     $200.00");
  });
});

