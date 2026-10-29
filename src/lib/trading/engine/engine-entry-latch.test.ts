import { describe, it, expect, vi } from "vitest";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { DeploymentState } from "./engine";
import { latchFilledEntry, type EntryLatchDeps } from "./engine-entry-latch";

const DEPL = "depl-a";
const TRADE_ID = 7;
const TODAY = "2026-10-09";
const YESTERDAY = "2026-10-08";
const SHORT = 1;

function trade(over: Partial<StrategyTrade> = {}): StrategyTrade {
  return { id: TRADE_ID, deploymentId: DEPL, side: SHORT, sessionKey: TODAY, ...over } as StrategyTrade;
}

function state(over: Partial<DeploymentState> = {}): DeploymentState {
  return { activeTradeId: TRADE_ID, pendingEntrySessionKey: TODAY, ...over } as DeploymentState;
}

function deps(s: DeploymentState | undefined) {
  return {
    stateFor: vi.fn(() => s),
    markEnteredThisSession: vi.fn(),
  } satisfies EntryLatchDeps;
}

describe("latchFilledEntry", () => {
  it("latches the stashed key and clears it when the trade is this process's", () => {
    const s = state();
    const d = deps(s);

    latchFilledEntry(d, trade());

    expect(d.markEnteredThisSession).toHaveBeenCalledWith(DEPL, TODAY, SHORT);
    expect(s.pendingEntrySessionKey).toBeNull();
  });

  // A92: an entry pending across a restart has no stash and is not the new
  // process's active trade.
  it("latches the row's key when the process holds no stash for the trade", () => {
    const d = deps(state({ activeTradeId: null, pendingEntrySessionKey: null }));

    latchFilledEntry(d, trade());

    expect(d.markEnteredThisSession).toHaveBeenCalledWith(DEPL, TODAY, SHORT);
  });

  it("latches the row's key when the deployment has no state at all", () => {
    const d = deps(undefined);

    latchFilledEntry(d, trade());

    expect(d.markEnteredThisSession).toHaveBeenCalledWith(DEPL, TODAY, SHORT);
  });

  it("never reads or clears another trade's stash", () => {
    const s = state({ activeTradeId: TRADE_ID + 1, pendingEntrySessionKey: YESTERDAY });
    const d = deps(s);

    latchFilledEntry(d, trade());

    expect(d.markEnteredThisSession).toHaveBeenCalledWith(DEPL, TODAY, SHORT);
    expect(d.markEnteredThisSession).not.toHaveBeenCalledWith(DEPL, YESTERDAY, SHORT);
    expect(s.pendingEntrySessionKey).toBe(YESTERDAY);
  });

  it("latches nothing for a strategy that emitted no key", () => {
    const d = deps(state({ pendingEntrySessionKey: null }));

    latchFilledEntry(d, trade({ sessionKey: null }));

    expect(d.markEnteredThisSession).not.toHaveBeenCalled();
  });
});
