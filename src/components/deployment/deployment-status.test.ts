/**
 * The deployment status ladder. These tests exercise the shipped
 * derivation and the shipped refusal constants — no local restatement of
 * the rung order or the reason text, because a helper that restates the
 * rule passes whatever the rule does.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEPLOYMENT_STATUS_LABELS,
  DEPLOYMENT_STATUS_LABELS_COMPACT,
  deriveDeploymentStatus,
  statusToneClass,
  type DeploymentStatusInput,
} from "./deployment-status";
import {
  autoTradeVerdict,
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
  type AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";
import { accountAutoTrade } from "@/lib/hooks/use-trading/account-row";
import { PLAYBOOK_NOT_IN_BUILD } from "@/lib/trading/strategies/prod-playbooks";

/** The server's verdicts on real Topstep account shapes — `PRAC-` is
 *  permitted, `TSTX-` is live. The ladder takes the verdict, never the row
 *  (bugs.md A38), so these come out of the shipped predicate. */
const PRAC: AutoTradeVerdict = autoTradeVerdict({ name: "PRAC-V2-12345", broker: "topstep", practice: true });
const LIVE: AutoTradeVerdict = autoTradeVerdict({ name: "TSTX-441122", broker: "topstep", practice: false });

function input(overrides: Partial<DeploymentStatusInput> = {}): DeploymentStatusInput {
  return { status: "Active", autoTrade: PRAC, hasLivePosition: false, ...overrides };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deriveDeploymentStatus — the live-account block", () => {
  it("reports a live account as withheld rather than flat", () => {
    expect(deriveDeploymentStatus(input({ autoTrade: LIVE }))).toEqual({
      kind: "no-auto-trade",
      tone: "danger",
      reason: LIVE_ACCOUNT_REFUSAL,
    });
  });

  it("reports an account missing from the catalogue as withheld, with the recoverable reason", () => {
    expect(deriveDeploymentStatus(input({ autoTrade: accountAutoTrade(null) }))).toEqual({
      kind: "no-auto-trade",
      tone: "danger",
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });

  it("does not withhold a Tradovate account on the live host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    expect(deriveDeploymentStatus(input({
      autoTrade: autoTradeVerdict({ name: "DEMO123", broker: "tradovate", practice: false }),
    })).kind).not.toBe("no-auto-trade");
  });

  it("A38 — withholds on the server's unverified verdict for an account the client holds a row for", () => {
    // The refusal the client could not reach: the row is in `/api/accounts`,
    // but its `account_brokers` row was never written, so the server refuses.
    expect(
      deriveDeploymentStatus(input({ autoTrade: { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL } })),
    ).toEqual({ kind: "no-auto-trade", tone: "danger", reason: UNVERIFIED_ACCOUNT_REFUSAL });
  });

  it("carries the refusal verbatim, never a re-worded summary", () => {
    const status = deriveDeploymentStatus(input({ autoTrade: LIVE }));
    expect(status.reason).toBe(LIVE_ACCOUNT_REFUSAL);
  });

  it("leaves reason unset on every permitted rung", () => {
    expect(deriveDeploymentStatus(input()).reason).toBeUndefined();
    expect(deriveDeploymentStatus(input({ status: "Paused" })).reason).toBeUndefined();
    expect(deriveDeploymentStatus(input({ detached: true })).reason).toBeUndefined();
  });
});

describe("deriveDeploymentStatus — rung order", () => {
  // A detached account is by definition absent from the catalogue, so the
  // verdict below this rung is UNVERIFIED for every detached row. Masking
  // Detached would stamp them all with a reload instruction that fixes
  // nothing.
  it("keeps Detached above the block even though the account is unclassifiable", () => {
    expect(deriveDeploymentStatus(input({ detached: true, autoTrade: accountAutoTrade(null) })).kind).toBe("detached");
  });

  it("keeps Paused above the block — the operator's own action wins", () => {
    expect(deriveDeploymentStatus(input({ status: "Paused", autoTrade: LIVE })).kind).toBe("paused");
  });

  it("keeps Pausing and Deleting above the block, and above Paused", () => {
    expect(deriveDeploymentStatus(input({ status: "Pausing", autoTrade: LIVE })).kind).toBe("pausing");
    expect(deriveDeploymentStatus(input({ status: "Destroying", autoTrade: LIVE })).kind).toBe(
      "destroying",
    );
  });

  it("never renders a closing deployment as Paused — a position may still be open", () => {
    expect(
      deriveDeploymentStatus(input({ status: "Pausing", hasLivePosition: true })).kind,
    ).toBe("pausing");
    expect(
      deriveDeploymentStatus(input({ status: "Destroying", hasLivePosition: true })).kind,
    ).toBe("destroying");
  });

  it("puts the block above every rung that claims the engine is running it", () => {
    expect(deriveDeploymentStatus(input({ autoTrade: LIVE, live: false })).kind).toBe("no-auto-trade");
    expect(
      deriveDeploymentStatus(input({ autoTrade: LIVE, openTradeStatus: "pending_entry" })).kind,
    ).toBe("no-auto-trade");
    expect(
      deriveDeploymentStatus(input({ autoTrade: LIVE, openTradeStatus: "pending_exit" })).kind,
    ).toBe("no-auto-trade");
    expect(deriveDeploymentStatus(input({ autoTrade: LIVE, hasLivePosition: true })).kind).toBe(
      "no-auto-trade",
    );
  });
});

describe("deriveDeploymentStatus — a playbook this build does not register", () => {
  it("reports it as not in build, with the shared sentence", () => {
    expect(deriveDeploymentStatus(input({ playbookInBuild: false }))).toEqual({
      kind: "not-in-build",
      tone: "danger",
      reason: PLAYBOOK_NOT_IN_BUILD,
    });
  });

  it("sits above every rung that claims the engine is running the row", () => {
    expect(deriveDeploymentStatus(input({ playbookInBuild: false, live: false })).kind).toBe(
      "not-in-build",
    );
    expect(
      deriveDeploymentStatus(input({ playbookInBuild: false, hasLivePosition: true })).kind,
    ).toBe("not-in-build");
  });

  it("sits under the operator's own pause and under the account block", () => {
    expect(deriveDeploymentStatus(input({ playbookInBuild: false, status: "Paused" })).kind).toBe(
      "paused",
    );
    expect(deriveDeploymentStatus(input({ playbookInBuild: false, autoTrade: LIVE })).kind).toBe(
      "no-auto-trade",
    );
  });

  it("is produced only by an explicit false", () => {
    expect(deriveDeploymentStatus(input()).kind).toBe("flat");
    expect(deriveDeploymentStatus(input({ playbookInBuild: true })).kind).toBe("flat");
  });
});

describe("deriveDeploymentStatus — the running rungs", () => {
  it("reports disconnected only when live is explicitly false", () => {
    expect(deriveDeploymentStatus(input({ live: false })).kind).toBe("disconnected");
    expect(deriveDeploymentStatus(input({ live: true })).kind).toBe("flat");
    // A surface with no disconnected state omits `live` rather than
    // passing a value it does not have.
    expect(deriveDeploymentStatus(input()).kind).toBe("flat");
  });

  it("reports pending entry and pending exit ahead of an open position", () => {
    expect(
      deriveDeploymentStatus(input({ openTradeStatus: "pending_entry", hasLivePosition: true }))
        .kind,
    ).toBe("pending-entry");
    expect(
      deriveDeploymentStatus(input({ openTradeStatus: "pending_exit", hasLivePosition: true })).kind,
    ).toBe("pending-exit");
  });

  it("reports in-position when a live position is owned, flat otherwise", () => {
    expect(deriveDeploymentStatus(input({ hasLivePosition: true })).kind).toBe("in-position");
    expect(deriveDeploymentStatus(input({ openTradeStatus: "open" })).kind).toBe("flat");
  });
});

describe("deriveDeploymentStatus — a setup the engine reads as armed", () => {
  const NOTE = "Range 21,410–21,452 set · waiting on a 5m close past either side.";

  it("turns flat into armed, carrying the playbook's note verbatim for the tooltip", () => {
    expect(deriveDeploymentStatus(input({ setupNote: NOTE }))).toEqual({
      kind: "armed-setup",
      tone: "warn",
      reason: NOTE,
    });
    expect(DEPLOYMENT_STATUS_LABELS["armed-setup"]).toBe("Armed");
    expect(DEPLOYMENT_STATUS_LABELS_COMPACT["armed-setup"]).toBe("Armed");
  });

  it("is flat when there is no reading — absent, null, or empty", () => {
    expect(deriveDeploymentStatus(input()).kind).toBe("flat");
    expect(deriveDeploymentStatus(input({ setupNote: null })).kind).toBe("flat");
    expect(deriveDeploymentStatus(input({ setupNote: "  " })).kind).toBe("flat");
  });

  it("never outranks another rung: it only ever replaces flat", () => {
    const armed = { setupNote: NOTE };
    const cases: Array<[Partial<DeploymentStatusInput>, string]> = [
      [{ detached: true }, "detached"],
      [{ status: "Pausing" }, "pausing"],
      [{ status: "Destroying" }, "destroying"],
      [{ status: "Paused" }, "paused"],
      [{ autoTrade: LIVE }, "no-auto-trade"],
      [{ playbookInBuild: false }, "not-in-build"],
      [{ live: false }, "disconnected"],
      [{ openTradeStatus: "pending_entry" }, "pending-entry"],
      [{ openTradeStatus: "pending_exit" }, "pending-exit"],
      [{ hasLivePosition: true }, "in-position"],
    ];
    for (const [over, kind] of cases) {
      const chip = deriveDeploymentStatus(input({ ...armed, ...over }));
      expect(chip.kind, kind).toBe(kind);
      expect(chip.reason, kind).not.toBe(NOTE);
    }
  });
});

describe("status labels", () => {
  it("wears the same words as the refused-row stamp, uncompacted", () => {
    expect(DEPLOYMENT_STATUS_LABELS["no-auto-trade"]).toBe("No Auto-Trade");
    expect(DEPLOYMENT_STATUS_LABELS_COMPACT["no-auto-trade"]).toBe(
      DEPLOYMENT_STATUS_LABELS["no-auto-trade"],
    );
  });

  it("paints the withheld chip in the same colour as the refused-row stamp", () => {
    const withheld = deriveDeploymentStatus(input({ autoTrade: LIVE }));
    expect(statusToneClass(withheld.tone)).toBe(
      "bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30",
    );
  });

  it("gives every rung a label on both surfaces", () => {
    const kinds = Object.keys(DEPLOYMENT_STATUS_LABELS);
    expect(Object.keys(DEPLOYMENT_STATUS_LABELS_COMPACT).sort()).toEqual(kinds.sort());
    for (const kind of kinds) {
      expect(DEPLOYMENT_STATUS_LABELS[kind as keyof typeof DEPLOYMENT_STATUS_LABELS].length)
        .toBeGreaterThan(0);
    }
  });
});
