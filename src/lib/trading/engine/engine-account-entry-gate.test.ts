import { describe, it, expect, vi } from "vitest";
import {
  AccountEntryGate,
  accountEntrySkip,
  accountEntrySkipMessage,
  ACCOUNT_ENTRY_RESUMED_EVENT,
  DETACHED_ENTRY_SKIP_EVENT,
} from "./engine-account-entry-gate";
import type { AccountDeployState } from "@/lib/trading/broker-access/account-state-gate";

const NOW = new Date("2026-10-14T15:00:00.000Z");
const LATER = new Date("2026-10-14T23:00:00.000Z");
const LOCK_END = "2026-10-14T22:00:00.000Z";

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

describe("accountEntrySkip", () => {
  it("skips a dead account", () => {
    expect(accountEntrySkip(state({ status: "dead" }), NOW)?.kind).toBe("dead");
  });

  // The line claims only what was read: a breach the check named, or the broker's report.
  it("words a dead skip by its cause — the breach's figures for max loss, the broker's report otherwise", () => {
    const breach = "maximum loss limit reached: balance $47,999.99 is at or under its $48,000.00 floor";
    const maxLoss = accountEntrySkip(state({ status: "dead", cause: "max-loss", lockoutReason: breach }), NOW)!;
    expect(accountEntrySkipMessage(maxLoss)).toBe(
      `Entries skipped: the account can no longer trade (${breach}). An open position is still managed ` +
        "to its exit. Move it to a replacement account or remove it.",
    );
    expect(accountEntrySkipMessage(maxLoss)).not.toContain("its broker reports");
    for (const cause of ["website", null] as const) {
      const dead = accountEntrySkip(state({ status: "dead", cause }), NOW)!;
      expect(accountEntrySkipMessage(dead)).toContain("its broker reports the account failed, ineligible or closed");
    }
  });

  it("skips a locked account until its stated end, and not after", () => {
    const locked = state({ status: "locked", lockoutReason: "Daily loss limit", lockoutUntil: LOCK_END });
    expect(accountEntrySkip(locked, NOW)?.kind).toBe("locked");
    expect(accountEntrySkip(locked, LATER)).toBeNull();
  });

  it("skips a lock with no end until the stored status changes", () => {
    expect(accountEntrySkip(state({ status: "locked" }), LATER)?.kind).toBe("locked");
  });

  it("skips a Topstep account whose OCO setting reads off", () => {
    expect(accountEntrySkip(state({ autoOcoBrackets: false }), NOW)?.kind).toBe("oco-off");
  });

  it("does not skip a Topstep account whose OCO setting is unknown — a running deployment keeps trading", () => {
    expect(accountEntrySkip(state({ autoOcoBrackets: null }), NOW)).toBeNull();
    expect(accountEntrySkip(state({ status: null, autoOcoBrackets: null }), NOW)).toBeNull();
  });

  it("never skips a Tradovate account on OCO", () => {
    expect(accountEntrySkip(state({ broker: "tradovate", autoOcoBrackets: false }), NOW)).toBeNull();
  });

  it("skips nothing for an account with no catalogue row", () => {
    expect(accountEntrySkip(null, NOW)).toBeNull();
  });
});

describe("AccountEntryGate", () => {
  function gate(initial: AccountDeployState | null) {
    let current = initial;
    let orphanReason: string | null = null;
    const announce = vi.fn();
    const g = new AccountEntryGate({
      readState: () => current,
      readOrphanReason: () => orphanReason,
      announce,
    });
    return {
      g,
      announce,
      set: (s: AccountDeployState | null) => (current = s),
      detach: (reason: string | null) => (orphanReason = reason),
    };
  }

  // A75: a detached row stays in the managed set and the exit loop; this gate
  // is what keeps it from opening a position.
  it("skips every entry of a detached deployment on a healthy account, said once", () => {
    const { g, announce, detach } = gate(state());
    detach("account_unavailable_at_boot");
    expect(g.skipsEntry("d1", 7, NOW)).toBe(true);
    expect(g.skipsEntry("d1", 7, NOW)).toBe(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("deployment_detached", "d1", 7, expect.any(String));
    expect(DETACHED_ENTRY_SKIP_EVENT).toBe("deployment_detached");
    expect(announce.mock.calls[0][3]).toContain("account_unavailable_at_boot");
    expect(announce.mock.calls[0][3]).toContain("An open position is still managed to its exit");
  });

  it("names the detach ahead of the account's own refusal", () => {
    const { g, announce, detach } = gate(state({ status: "dead" }));
    detach("place_order_account_not_found");
    g.skipsEntry("d1", 7, NOW);
    expect(announce.mock.calls.map((c) => c[0])).toEqual([DETACHED_ENTRY_SKIP_EVENT]);
  });

  it("takes entries again once the marker is cleared, without a resumed line about the account", () => {
    const { g, announce, detach } = gate(state());
    detach("periodic_account_check");
    g.skipsEntry("d1", 7, NOW);
    detach(null);
    expect(g.skipsEntry("d1", 7, NOW)).toBe(false);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("says a skip once per deployment, however many bars it holds", () => {
    const { g, announce } = gate(state({ status: "dead" }));
    expect(g.skipsEntry("d1", 7, NOW)).toBe(true);
    expect(g.skipsEntry("d1", 7, NOW)).toBe(true);
    expect(g.skipsEntry("d1", 7, NOW)).toBe(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith("deployment_account_dead", "d1", 7, expect.any(String));
  });

  it("says it once for each deployment on the account", () => {
    const { g, announce } = gate(state({ status: "dead" }));
    g.skipsEntry("d1", 7, NOW);
    g.skipsEntry("d2", 7, NOW);
    g.skipsEntry("d1", 7, NOW);
    expect(announce.mock.calls.map((c) => c[1])).toEqual(["d1", "d2"]);
  });

  it("says a change of reason, and says once when the skip clears", () => {
    const { g, announce, set } = gate(state({ autoOcoBrackets: false }));
    g.skipsEntry("d1", 7, NOW);
    set(state({ status: "locked", lockoutUntil: LOCK_END }));
    g.skipsEntry("d1", 7, NOW);
    g.skipsEntry("d1", 7, NOW);
    // The lock's end passes on the clock alone — no new check needed.
    expect(g.skipsEntry("d1", 7, LATER)).toBe(false);
    expect(g.skipsEntry("d1", 7, LATER)).toBe(false);
    expect(announce.mock.calls.map((c) => c[0])).toEqual([
      "deployment_account_oco_off",
      "deployment_account_locked",
      ACCOUNT_ENTRY_RESUMED_EVENT,
    ]);
  });

  it("says nothing for an account that was never skipped", () => {
    const { g, announce } = gate(state());
    expect(g.skipsEntry("d1", 7, NOW)).toBe(false);
    expect(announce).not.toHaveBeenCalled();
  });

  it("re-announces a standing skip after a reset (engine stop)", () => {
    const { g, announce } = gate(state({ status: "dead" }));
    g.skipsEntry("d1", 7, NOW);
    g.reset();
    g.skipsEntry("d1", 7, NOW);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("forgets a deployment the sync dropped, silently", () => {
    const { g, announce, set } = gate(state({ status: "dead" }));
    g.skipsEntry("d1", 7, NOW);
    g.retain(new Set());
    set(state());
    g.skipsEntry("d1", 7, NOW);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("names the lock's end in ET, and says when the broker gave none", () => {
    const { g, announce, set } = gate(
      state({ status: "locked", lockoutReason: "Daily loss limit", lockoutUntil: LOCK_END }),
    );
    g.skipsEntry("d1", 7, NOW);
    expect(announce.mock.calls[0][3]).toContain("locked out (Daily loss limit) until Wed, Oct 14, 6:00 PM ET");
    set(state({ status: "locked" }));
    g.reset();
    g.skipsEntry("d1", 7, NOW);
    expect(announce.mock.calls[1][3]).toContain("gave no end time");
  });
});
