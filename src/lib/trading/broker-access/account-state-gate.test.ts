import { describe, it, expect } from "vitest";
import {
  ACCOUNT_DEAD_REFUSAL,
  ACCOUNT_STATE_CAUSE_STAMP,
  ACCOUNT_STATE_STAMP,
  accountStateStamp,
  AUTO_OCO_OFF_REFUSAL,
  AUTO_OCO_UNKNOWN_REFUSAL,
  accountStateVerdict,
  autoBracketWarning,
  lockedRefusal,
  moveToReplacementTitle,
  replacementCandidates,
  type AccountDeployState,
  type ReplacementPoolEntry,
} from "./account-state-gate";

// 2026-10-14 11:00 ET, inside the RTH session.
const NOW = new Date("2026-10-14T15:00:00.000Z");

function state(over: Partial<AccountDeployState> = {}): AccountDeployState {
  return {
    broker: "topstep",
    status: "ok",
    cause: null,
    lockoutReason: null,
    lockoutUntil: null,
    autoOcoBrackets: true,
    bracketAutoApply: false,
    bracketRiskUsd: null,
    bracketTargetUsd: null,
    ...over,
  };
}

describe("accountStateVerdict", () => {
  it("permits an ok Topstep account with OCO on, with no warning", () => {
    expect(accountStateVerdict(state(), NOW)).toEqual({ permitted: true, warning: null });
  });

  it("refuses a dead account, ahead of every other reason", () => {
    expect(accountStateVerdict(state({ status: "dead", autoOcoBrackets: false }), NOW)).toEqual({
      permitted: false,
      kind: "dead",
      stamp: "Dead",
      reason: ACCOUNT_DEAD_REFUSAL,
    });
  });

  it("refuses a locked account until its end, naming the reason and the end in ET", () => {
    const v = accountStateVerdict(
      state({ status: "locked", lockoutReason: "Daily Loss Limit", lockoutUntil: "2026-10-14T21:00:00.000Z" }),
      NOW,
    );
    expect(v).toEqual({
      permitted: false,
      kind: "locked",
      stamp: "Locked",
      reason: lockedRefusal("Daily Loss Limit", new Date("2026-10-14T21:00:00.000Z")),
    });
    expect(v.permitted ? "" : v.reason).toContain("Oct 14, 5:00 PM ET");
  });

  it("permits a locked account once its stated end has passed", () => {
    const v = accountStateVerdict(
      state({ status: "locked", lockoutUntil: "2026-10-14T14:59:59.000Z" }),
      NOW,
    );
    expect(v.permitted).toBe(true);
  });

  it("refuses a lock with no end — the search fallback's — as open-ended", () => {
    const v = accountStateVerdict(state({ status: "locked" }), NOW);
    expect(v).toEqual({ permitted: false, kind: "locked", stamp: "Locked", reason: lockedRefusal(null, null) });
    expect(lockedRefusal(null, null)).toContain("did not say until when");
  });

  it("refuses a Topstep account whose OCO is off, in the operator's sentence", () => {
    expect(accountStateVerdict(state({ autoOcoBrackets: false }), NOW)).toEqual({
      permitted: false,
      kind: "oco-off",
      stamp: "OCO Off",
      reason: AUTO_OCO_OFF_REFUSAL,
    });
    expect(AUTO_OCO_OFF_REFUSAL).toBe(
      "Auto OCO Brackets is off for this account in Topstep. Turn it on in Topstep's settings, then try again.",
    );
  });

  it("refuses a Topstep account whose OCO is unknown, with its own sentence", () => {
    expect(accountStateVerdict(state({ autoOcoBrackets: null }), NOW)).toEqual({
      permitted: false,
      kind: "oco-unknown",
      stamp: "OCO Unknown",
      reason: AUTO_OCO_UNKNOWN_REFUSAL,
    });
  });

  // The sentence reaches the deploy screens and the reconciler's log lines, so
  // it names what clears it rather than a screen to reopen during an outage.
  it("says the unknown OCO clears on the next account check, hourly or when Settings opens", () => {
    expect(AUTO_OCO_UNKNOWN_REFUSAL).not.toMatch(/reopen/i);
    expect(AUTO_OCO_UNKNOWN_REFUSAL).toContain("every hour");
    expect(AUTO_OCO_UNKNOWN_REFUSAL).toContain("opening Settings");
  });

  it("refuses a never-checked Topstep account on the unknown OCO, not on its status", () => {
    const v = accountStateVerdict(state({ status: null, autoOcoBrackets: null }), NOW);
    expect(v.permitted ? null : v.kind).toBe("oco-unknown");
  });

  it("never refuses a Tradovate account on OCO, unknown or false", () => {
    for (const autoOcoBrackets of [null, false]) {
      expect(accountStateVerdict(state({ broker: "tradovate", autoOcoBrackets }), NOW)).toEqual({
        permitted: true,
        warning: null,
      });
    }
  });

  it("still refuses a dead Tradovate account", () => {
    const v = accountStateVerdict(state({ broker: "tradovate", status: "dead" }), NOW);
    expect(v.permitted ? null : v.kind).toBe("dead");
  });

  it("warns, and permits, when Topstep's auto bracket is on — naming its amounts", () => {
    const v = accountStateVerdict(
      state({ bracketAutoApply: true, bracketRiskUsd: 300, bracketTargetUsd: 600 }),
      NOW,
    );
    expect(v).toEqual({ permitted: true, warning: autoBracketWarning(300, 600) });
    expect(autoBracketWarning(300, 600)).toContain("$300 stop and $600 target");
    expect(autoBracketWarning(null, 600)).toContain("its own stop and target");
  });
});

describe("the stamp and sentence by cause", () => {
  const UNTIL = "2026-10-14T22:00:00.000Z";
  const DLL = "daily loss limit reached: lost $1,041.66 of a $1,000.00 limit today";
  const TARGET = "daily profit target reached: up $1,250.00 on a $1,000.00 target today";
  const MAX = "maximum loss limit reached: balance $47,999.99 is at or under its $48,000.00 floor";

  it("stamps a daily-loss lock DLL and names its figures in the sentence", () => {
    const v = accountStateVerdict(
      state({ status: "locked", cause: "daily-loss", lockoutReason: DLL, lockoutUntil: UNTIL }),
      NOW,
    );
    expect(v).toEqual({
      permitted: false,
      kind: "locked",
      stamp: "DLL",
      reason: lockedRefusal(DLL, new Date(UNTIL)),
    });
    expect(v.permitted ? "" : v.reason).toContain("lost $1,041.66 of a $1,000.00 limit");
  });

  it("stamps a profit-target lock Profit Target with its figures", () => {
    const v = accountStateVerdict(
      state({ status: "locked", cause: "profit-target", lockoutReason: TARGET, lockoutUntil: UNTIL }),
      NOW,
    );
    expect(v.permitted ? null : [v.stamp, v.reason]).toEqual([
      "Profit Target",
      lockedRefusal(TARGET, new Date(UNTIL)),
    ]);
  });

  it("stamps a maximum-loss dead Max Loss, its sentence naming the balance and the floor", () => {
    const v = accountStateVerdict(state({ status: "dead", cause: "max-loss", lockoutReason: MAX }), NOW);
    expect(v).toEqual({
      permitted: false,
      kind: "dead",
      stamp: "Max Loss",
      reason: `This account can no longer trade (${MAX}). Use another account.`,
    });
  });

  it("keeps Locked and Dead for the website, cannot-trade and unknown causes, with the website's own reason", () => {
    for (const cause of ["website", "cannot-trade", null] as const) {
      const locked = accountStateVerdict(state({ status: "locked", cause, lockoutReason: "Manual lockout" }), NOW);
      expect(locked.permitted ? null : [locked.stamp, locked.reason]).toEqual([
        "Locked",
        lockedRefusal("Manual lockout", null),
      ]);
      const dead = accountStateVerdict(state({ status: "dead", cause }), NOW);
      expect(dead.permitted ? null : [dead.stamp, dead.reason]).toEqual(["Dead", ACCOUNT_DEAD_REFUSAL]);
    }
  });

  // A cause only relabels the kind it produces; it never changes what is refused.
  it("never relabels a kind its cause does not produce, nor refuses an ok", () => {
    expect(accountStateStamp("dead", "daily-loss")).toBe(ACCOUNT_STATE_STAMP.dead);
    expect(accountStateStamp("locked", "max-loss")).toBe(ACCOUNT_STATE_STAMP.locked);
    expect(accountStateStamp("oco-off", "profit-target")).toBe(ACCOUNT_STATE_STAMP["oco-off"]);
    expect(accountStateVerdict(state({ cause: "daily-loss" }), NOW)).toEqual({ permitted: true, warning: null });
  });

  it("reads every stamp in Title Case with acronyms upper case", () => {
    expect(Object.values(ACCOUNT_STATE_STAMP)).toEqual(["Dead", "Locked", "OCO Off", "OCO Unknown"]);
    expect(Object.values(ACCOUNT_STATE_CAUSE_STAMP)).toEqual(["DLL", "Profit Target", "Max Loss"]);
  });
});

describe("moveToReplacementTitle", () => {
  it("names the target, the paused legs that come back on, and what the operator still sets", () => {
    const title = moveToReplacementTitle("PRAC-V2-1");
    expect(title).toContain("PRAC-V2-1");
    expect(title).toContain("comes back on");
    expect(title).toContain("risk per trade");
    expect(title).toContain("maximum loss limit and starting balance");
  });
});

describe("replacementCandidates", () => {
  const dead = { accountId: 1, templateId: 67, startingBalanceUsd: 50_000 };
  function entry(over: Partial<ReplacementPoolEntry> & { accountId: number }): ReplacementPoolEntry {
    return {
      name: `acct-${over.accountId}`,
      status: "ok",
      templateId: 67,
      startingBalanceUsd: 50_000,
      deployable: true,
      ...over,
    };
  }

  it("offers an ok, deployable, unused account on the same template and balance", () => {
    expect(replacementCandidates(dead, [entry({ accountId: 2 })], new Set([1]))).toEqual([
      { accountId: 2, name: "acct-2" },
    ]);
  });

  it("offers every match, so the operator can pick between several", () => {
    const pool = [entry({ accountId: 2 }), entry({ accountId: 3 })];
    expect(replacementCandidates(dead, pool, new Set([1])).map((c) => c.accountId)).toEqual([2, 3]);
  });

  it("offers nothing that differs on program, balance, status, gates or use", () => {
    const pool = [
      entry({ accountId: 2, templateId: 68 }),
      entry({ accountId: 3, startingBalanceUsd: 150_000 }),
      entry({ accountId: 4, status: "locked" }),
      entry({ accountId: 5, status: null }),
      entry({ accountId: 6, deployable: false }),
      entry({ accountId: 7 }),
      entry({ accountId: 1 }),
    ];
    expect(replacementCandidates(dead, pool, new Set([1, 7]))).toEqual([]);
  });

  it("offers nothing when the dead account's program is unknown", () => {
    const pool = [entry({ accountId: 2 })];
    expect(replacementCandidates({ ...dead, templateId: null }, pool, new Set())).toEqual([]);
    expect(replacementCandidates({ ...dead, startingBalanceUsd: null }, pool, new Set())).toEqual([]);
  });
});
