/**
 * *Which of the five endings an account's risk row is in.*
 *
 * The arithmetic is not tested here and must not be — `resolveSessionBudget`
 * is pinned to the cent in its own suite, and a second set of bucket
 * assertions is how two surfaces start disagreeing about money. What this
 * file pins is the part that is this module's own: that a missing posture is
 * answered *before* the resolver is asked, that a throw is an ending carrying
 * the engine's own sentence rather than an error to swallow, and that the two
 * stale cases stay two facts.
 */

import { describe, it, expect } from "vitest";
import {
  listedOnRisk,
  readAccountRisk,
  riskPrefillOf,
  type AccountRiskWireRow,
  type RiskListRow,
} from "./account-risk-view";
import {
  NON_TOPSTEP_PHASE_REFUSAL,
  PHASE_NEEDS_RISK_POSTURE_REFUSAL,
  type AccountRiskPhase,
} from "@/lib/trading/orders/account-phase-sizer";
import { currentCmeSessionStart } from "@/lib/trading/session/session";

const NOW = new Date("2026-09-11T14:00:00.000Z");

function row(overrides: Partial<AccountRiskWireRow> = {}): AccountRiskWireRow {
  return {
    accountId: 5001,
    broker: "topstep",
    posture: { maxRiskPerTradeUsd: 500, maxContracts: 3 },
    riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null },
    eodSample: { balanceUsd: null, peakUsd: null, sizesSessionStart: null, recordedAt: null },
    ...overrides,
  };
}

/** Peak 51,000 → floor 49,000; close 50,750 → headroom 1,750 → the top
 *  bucket, stamped for the session `NOW` falls in. */
function combine(overrides: Partial<AccountRiskWireRow> = {}): AccountRiskWireRow {
  return row({
    riskPhase: { phase: "combine", mllUsd: 2000, startBalanceUsd: 50000, payoutTakenAt: null },
    eodSample: {
      balanceUsd: 50750,
      peakUsd: 51000,
      sizesSessionStart: currentCmeSessionStart(NOW),
      recordedAt: NOW.toISOString(),
    },
    ...overrides,
  });
}

describe("readAccountRisk", () => {
  it("answers a missing posture without asking the resolver", () => {
    // The resolver's own sentence for this case names the *phase*, which is
    // the wrong subject for a row whose missing thing is the pair of numbers
    // above it — and an account with no posture takes no trade whatever its
    // phase says.
    const reading = readAccountRisk(combine({ posture: null }), NOW);
    expect(reading).toEqual({ kind: "unset" });
    expect(JSON.stringify(reading)).not.toContain(PHASE_NEEDS_RISK_POSTURE_REFUSAL);
  });

  it("reads a phase of Off as the flat number the operator typed", () => {
    expect(readAccountRisk(row(), NOW)).toEqual({ kind: "flat", budgetUsd: 500 });
  });

  it("carries the facts behind a sized budget, and the close it was sized from", () => {
    const reading = readAccountRisk(combine(), NOW);
    expect(reading).toEqual({
      kind: "sized",
      phase: "combine",
      budgetUsd: 500,
      headroomUsd: 1750,
      floorUsd: 49000,
      closeStamp: NOW.toISOString(),
    });
  });

  it("tells a never-sampled account from one whose close is a session old", () => {
    // *"…yet"* names a cause, and the two are not the same fact: one has no
    // close at all, the other has one the app took and cannot use.
    expect(readAccountRisk(combine({ eodSample: null }), NOW)).toMatchObject({
      kind: "lowest",
      everSampled: false,
      budgetUsd: 225,
    });
    expect(
      readAccountRisk(
        combine({
          eodSample: {
            balanceUsd: 50750,
            peakUsd: 51000,
            sizesSessionStart: "2026-09-01T22:00:00.000Z",
            recordedAt: "2026-09-01T22:00:00.000Z",
          },
        }),
        NOW,
      ),
    ).toMatchObject({ kind: "lowest", everSampled: true, budgetUsd: 225 });
  });

  it("turns a throw into an ending, in the engine's own words", () => {
    expect(readAccountRisk(combine({ broker: "tradovate" }), NOW)).toEqual({
      kind: "refused",
      reason: NON_TOPSTEP_PHASE_REFUSAL,
    });
  });

  it("reads a phase it does not recognise as Off, never through the buckets", () => {
    // `parseAccountRiskPhase` is the fail-closed parser and this is the field
    // it exists for: a row written by a future version, or by anything else
    // that reaches the table, must fall through to today's flat posture. The
    // combine sample here would size at $500 through the bands and the flat
    // number is $500 too, so the *basis* is what this asserts — `flat`, not
    // `sized`.
    const reading = readAccountRisk(
      combine({
        riskPhase: {
          phase: "funded_scaled" as unknown as AccountRiskPhase,
          mllUsd: 2000,
          startBalanceUsd: 50000,
          payoutTakenAt: null,
        },
      }),
      NOW,
    );
    expect(reading).toEqual({ kind: "flat", budgetUsd: 500 });
  });

  it("sizes a body with no phase columns at all as Off rather than throwing", () => {
    // The wire row is asserted at the fetch boundary, not validated, so a
    // stub or a route one deploy behind must read as *no phase* instead of
    // taking a render down.
    expect(
      readAccountRisk({ accountId: 5001, broker: "topstep", posture: { maxRiskPerTradeUsd: 225, maxContracts: 1 } }, NOW),
    ).toEqual({ kind: "flat", budgetUsd: 225 });
  });
});

describe("listedOnRisk", () => {
  const POSTURE = { maxRiskPerTradeUsd: 350, maxContracts: 3 };
  const PROD = { production: true };
  const STAGING = { production: false };

  function listRow(over: Partial<RiskListRow> = {}): RiskListRow {
    return { posture: null, practice: false, status: { state: "ok" }, ...over };
  }

  it("drops an account its broker reports dead once nothing is set on it, on every build", () => {
    for (const opts of [PROD, STAGING]) {
      expect(listedOnRisk(listRow({ status: { state: "dead" } }), opts)).toBe(false);
      expect(
        listedOnRisk(listRow({ status: { state: "dead" }, practice: true }), opts),
      ).toBe(false);
    }
  });

  // One false "dead" — a broker that omitted a live account once — sticks
  // until the next refresh lists it again, while the engine may still trade
  // it. Hiding an armed row for that long leaves a posture nobody can clear.
  it("keeps a dead account listed while it still has a risk per trade, on every build", () => {
    for (const opts of [PROD, STAGING]) {
      expect(listedOnRisk(listRow({ status: { state: "dead" }, posture: POSTURE }), opts)).toBe(
        true,
      );
      expect(
        listedOnRisk(
          listRow({ status: { state: "dead" }, posture: POSTURE, practice: true }),
          opts,
        ),
      ).toBe(true);
    }
  });

  it("lists a locked account with nothing set on it, on every build that lists its class", () => {
    expect(listedOnRisk(listRow({ status: { state: "locked" } }), PROD)).toBe(true);
    expect(listedOnRisk(listRow({ status: { state: "locked" }, practice: true }), STAGING)).toBe(
      true,
    );
  });

  it("lists an account whose status was never checked, or is missing from the wire", () => {
    expect(listedOnRisk(listRow({ status: { state: null } }), PROD)).toBe(true);
    expect(listedOnRisk(listRow({ status: undefined }), PROD)).toBe(true);
    expect(listedOnRisk(listRow({ status: null }), PROD)).toBe(true);
  });

  it("drops a practice account on prod, and lists it everywhere else", () => {
    expect(listedOnRisk(listRow({ practice: true }), PROD)).toBe(false);
    expect(listedOnRisk(listRow({ practice: true }), STAGING)).toBe(true);
  });

  // Prod still auto-trades a practice account, so hiding one that carries a
  // risk per trade would leave an armed account the operator cannot see or
  // clear. It drops off once cleared.
  it("keeps a practice account on prod listed while it still has a risk per trade", () => {
    expect(listedOnRisk(listRow({ practice: true, posture: POSTURE }), PROD)).toBe(true);
  });

  it("lists an unclassifiable account on prod — it is not known to be practice", () => {
    expect(listedOnRisk(listRow({ practice: null }), PROD)).toBe(true);
  });

  // Staging auto-trades practice accounts only, so anything else is a row it
  // would refuse — unless it still carries a risk per trade.
  it("drops a non-practice or unclassifiable account off prod unless it still has a risk per trade", () => {
    expect(listedOnRisk(listRow({ practice: false }), STAGING)).toBe(false);
    expect(listedOnRisk(listRow({ practice: null }), STAGING)).toBe(false);
    expect(listedOnRisk(listRow({ practice: false, posture: POSTURE }), STAGING)).toBe(true);
  });
});

/** The suggestions read from Topstep's website record — temp/tradingaccount.json's
 *  accounts, probed 2026-10-14. */
describe("riskPrefillOf", () => {
  const COMBINE = {
    startingBalanceUsd: 50_000,
    highestBalanceUsd: 51_969.94,
    maximumLossUsd: 49_969.94,
    dailyLossUsd: 1_000,
    personalDailyLossLimitUsd: null,
    stage: 1,
  };

  it("suggests the starting balance, the loss limit from the trailed floor, and Combine on stage 1", () => {
    expect(riskPrefillOf(COMBINE)).toEqual({
      startBalanceUsd: 50_000,
      mllUsd: 2_000,
      dailyLossUsd: null,
      phase: "combine",
      brokerDailyLossUsd: 1_000,
    });
  });

  it("measures the limit from the starting balance when no highest balance was reported", () => {
    expect(riskPrefillOf({ ...COMBINE, highestBalanceUsd: null, maximumLossUsd: 48_000 }).mllUsd).toBe(2_000);
  });

  it("suggests no limit once the floor has locked at the starting balance", () => {
    expect(
      riskPrefillOf({ startingBalanceUsd: 150_000, highestBalanceUsd: 158_909.5, maximumLossUsd: 150_000, stage: 4 })
        .mllUsd,
    ).toBeNull();
  });

  it("takes the daily loss from the operator's own Topstep limit, and never from the program's", () => {
    expect(riskPrefillOf(COMBINE).dailyLossUsd).toBeNull();
    expect(riskPrefillOf({ ...COMBINE, personalDailyLossLimitUsd: 600 }).dailyLossUsd).toBe(600);
  });

  // Combine sizes only a $2,000 limit; suggesting it beside any other would
  // hand the operator a pairing Save refuses.
  it("suggests Combine only when the suggested limit is $2,000", () => {
    const big = { ...COMBINE, startingBalanceUsd: 150_000, highestBalanceUsd: 150_000, maximumLossUsd: 145_500 };
    expect(riskPrefillOf(big)).toMatchObject({ mllUsd: 4_500, phase: null });
    expect(riskPrefillOf({ ...COMBINE, maximumLossUsd: null }).phase).toBeNull();
  });

  it("suggests no phase for a stage code it does not know", () => {
    expect(riskPrefillOf({ ...COMBINE, stage: 4 }).phase).toBeNull();
    expect(riskPrefillOf({ ...COMBINE, stage: null }).phase).toBeNull();
  });

  it("suggests nothing without a website record", () => {
    expect(riskPrefillOf(null)).toEqual({
      startBalanceUsd: null,
      mllUsd: null,
      dailyLossUsd: null,
      phase: null,
      brokerDailyLossUsd: null,
    });
  });
});
