/**
 * The session budget, to the cent.
 *
 * Every number here is a measured posture rather than a plausible one — the
 * bucket boundaries, the lock, the de-risk ramp and the lowest-budget fallback
 * are the acceptance checks of
 * [docs/strategies/accounts/phase-aware-sizer.md] §9, and a change that moves
 * any of them is a change to what the account risks per trade.
 *
 * The clock is pinned because the function asks `currentCmeSessionStart(now)`
 * whether the close sample is the one that sizes today: unpinned, the stale
 * arm and the live arm swap over depending on when the suite runs.
 */
import { describe, it, expect } from "vitest";
import {
  accountAtFloorRefusal,
  COMBINE_MLL_REFUSAL,
  COMBINE_MLL_USD,
  NON_TOPSTEP_PHASE_REFUSAL,
  parseAccountRiskPhase,
  phaseRuleParameterRefusal,
  PHASE_NEEDS_RISK_POSTURE_REFUSAL,
  resolveSessionBudget,
  type SessionBudgetRow,
} from "./account-phase-sizer";
import { NO_PLAYBOOK_LIMITS, resolveRiskSizedContracts } from "./risk-sizer";
import { currentCmeSessionStart } from "../session/session";

/** Wednesday 2026-09-09, 10:00 ET — inside the session that opened Tuesday
 *  18:00 ET, which is the stamp a close taken at Tuesday's 17:00 close carries. */
const NOW = new Date("2026-09-09T14:00:00.000Z");
const TODAY = currentCmeSessionStart(NOW);
/** The session before it: the stamp a sample left behind by a missed close. */
const YESTERDAY = currentCmeSessionStart(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));

function combine(over: Partial<SessionBudgetRow> = {}): SessionBudgetRow {
  return {
    broker: "topstep",
    riskPhase: "combine",
    mllUsd: COMBINE_MLL_USD,
    startBalanceUsd: 50_000,
    pressAtUsd: null,
    eodBalanceUsd: 50_000,
    eodPeakUsd: 50_000,
    eodSizesSessionStart: TODAY,
    maxRiskPerTradeUsd: 500,
    maxContracts: 3,
    ...over,
  };
}

function press(over: Partial<SessionBudgetRow> = {}): SessionBudgetRow {
  return combine({ riskPhase: "combine_press", pressAtUsd: 1_500, ...over });
}

function funded(over: Partial<SessionBudgetRow> = {}): SessionBudgetRow {
  return {
    ...combine(),
    riskPhase: "funded_fresh",
    startBalanceUsd: 0,
    eodBalanceUsd: 2_000,
    eodPeakUsd: 2_000,
    ...over,
  };
}

function budgetOf(row: SessionBudgetRow): number {
  const { posture } = resolveSessionBudget(row, NOW);
  if (posture == null) throw new Error("expected a posture");
  return posture.maxRiskPerTradeUsd;
}

describe("resolveSessionBudget — the combine buckets", () => {
  // Peak 51,000 with a 2,000 MLL puts the floor at 49,000, below the 50,000
  // lock, so the account is on the buckets rather than locked.
  const atPeak = (over: Partial<SessionBudgetRow> = {}) =>
    combine({ eodPeakUsd: 51_000, ...over });

  it("pays the top bucket at exactly the top-band headroom", () => {
    expect(budgetOf(atPeak({ eodBalanceUsd: 50_750 }))).toBe(500);
    expect(resolveSessionBudget(atPeak({ eodBalanceUsd: 50_750 }), NOW)).toMatchObject({
      basis: "bucket_500",
      headroomUsd: 1_750,
      floorUsd: 49_000,
      closeUsd: 50_750,
      peakUsd: 51_000,
      sizesSessionStart: TODAY,
    });
  });

  it("drops a bucket one cent under it", () => {
    expect(budgetOf(atPeak({ eodBalanceUsd: 50_749.99 }))).toBe(350);
  });

  it("holds the middle bucket down to exactly the middle band", () => {
    expect(budgetOf(atPeak({ eodBalanceUsd: 50_250 }))).toBe(350);
    expect(budgetOf(atPeak({ eodBalanceUsd: 50_249.99 }))).toBe(225);
  });

  it("throws on a close at the floor rather than sizing the lowest bucket", () => {
    // Busted, or the inputs are wrong. Either way no order — this is not the
    // sizer's transient too-wide-stop skip.
    expect(() => budgetOf(atPeak({ eodBalanceUsd: 49_000 }))).toThrow(
      accountAtFloorRefusal(49_000, 49_000),
    );
  });
});

// Peak 51,000 puts the floor at 49,000 (unlocked); a close of 50,500 is
// exactly the $1,500 threshold above it.
describe("resolveSessionBudget — combine_press", () => {
  it("combine_press pays $500 at headroom exactly the press threshold", () => {
    expect(resolveSessionBudget(press({ eodPeakUsd: 51_000, eodBalanceUsd: 50_500 }), NOW)).toMatchObject({
      phase: "combine_press",
      basis: "bucket_500",
      headroomUsd: 1_500,
      floorUsd: 49_000,
      posture: { maxRiskPerTradeUsd: 500 },
    });
  });

  it("combine_press pays $350 one cent under the press threshold", () => {
    expect(resolveSessionBudget(press({ eodPeakUsd: 51_000, eodBalanceUsd: 50_499.99 }), NOW)).toMatchObject({
      basis: "bucket_350",
      posture: { maxRiskPerTradeUsd: 350 },
    });
  });

  it("combine_press never drops below $350 however close to the floor", () => {
    expect(budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 49_000.01 }))).toBe(350);
  });

  it("combine_press takes $350 on the stale arm", () => {
    const noSample = { eodBalanceUsd: null, eodPeakUsd: null, eodSizesSessionStart: null };
    expect(resolveSessionBudget(press(noSample), NOW)).toMatchObject({
      basis: "stale_floor",
      posture: { maxRiskPerTradeUsd: 350 },
    });
    expect(budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 51_000, eodSizesSessionStart: YESTERDAY }))).toBe(350);
  });

  // Locked at 50,000 from a 52,000 peak: the combine would answer $225 at any
  // headroom; the press reads the headroom alone.
  it("combine_press ignores the lock: $350 under the threshold, $500 over it", () => {
    expect(budgetOf(press({ eodPeakUsd: 52_000, eodBalanceUsd: 51_499.99 }))).toBe(350);
    expect(resolveSessionBudget(press({ eodPeakUsd: 52_000, eodBalanceUsd: 51_500 }), NOW)).toMatchObject({
      basis: "bucket_500",
      floorUsd: 50_000,
      headroomUsd: 1_500,
      posture: { maxRiskPerTradeUsd: 500 },
    });
  });

  it("combine_press throws at and below the floor", () => {
    expect(() => budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 49_000 }))).toThrow(
      accountAtFloorRefusal(49_000, 49_000),
    );
    expect(() => budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 48_500 }))).toThrow(
      accountAtFloorRefusal(48_500, 49_000),
    );
  });

  it("combine_press throws on a missing press threshold, with or without a close", () => {
    const refusal = phaseRuleParameterRefusal("press threshold", null);
    expect(() => budgetOf(press({ pressAtUsd: null }))).toThrow(refusal);
    expect(() =>
      budgetOf(press({ pressAtUsd: null, eodBalanceUsd: null, eodPeakUsd: null, eodSizesSessionStart: null })),
    ).toThrow(refusal);
    expect(() => budgetOf(press({ pressAtUsd: 0 }))).toThrow(phaseRuleParameterRefusal("press threshold", 0));
  });

  it("combine_press throws on any loss limit but $2,000", () => {
    expect(() => budgetOf(press({ mllUsd: 3_000 }))).toThrow(COMBINE_MLL_REFUSAL);
  });

  it("combine_press is capped by risk per trade: a $350 ceiling never presses", () => {
    expect(budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 51_000, maxRiskPerTradeUsd: 350 }))).toBe(350);
  });

  it("combine_press under a $1,000 ceiling still presses only to $500", () => {
    expect(budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 50_500, maxRiskPerTradeUsd: 1_000 }))).toBe(500);
  });

  it("combine_press under a $400 ceiling presses to $400 and stays $350 under the threshold", () => {
    expect(budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 50_500, maxRiskPerTradeUsd: 400 }))).toBe(400);
    expect(budgetOf(press({ eodPeakUsd: 51_000, eodBalanceUsd: 50_499.99, maxRiskPerTradeUsd: 400 }))).toBe(350);
  });

  // Close 49,400 on a 50,000 start: trailed from the start the floor is 48,000
  // and headroom 1,400 (under the threshold); trailed from the recorded close
  // it would be 47,400 and 2,000, which presses.
  it("combine_press trails from the starting balance after a losing first day (A96)", () => {
    expect(resolveSessionBudget(press({ eodPeakUsd: 49_400, eodBalanceUsd: 49_400 }), NOW)).toMatchObject({
      floorUsd: 48_000,
      headroomUsd: 1_400,
      peakUsd: 50_000,
      basis: "bucket_350",
      posture: { maxRiskPerTradeUsd: 350 },
    });
  });

  it("every other phase ignores the press threshold", () => {
    expect(budgetOf(combine({ eodPeakUsd: 51_000, eodBalanceUsd: 50_500, pressAtUsd: 1 }))).toBe(350);
    expect(budgetOf(combine({ pressAtUsd: null }))).toBe(500);
  });
});

describe("resolveSessionBudget — the trailing floor", () => {
  it("takes the lowest bucket once the limit has locked", () => {
    const locked = combine({ eodPeakUsd: 52_000, eodBalanceUsd: 52_900 });
    expect(budgetOf(locked)).toBe(225);
    expect(resolveSessionBudget(locked, NOW)).toMatchObject({
      basis: "locked",
      floorUsd: 50_000,
      headroomUsd: 2_900,
    });
  });

  it("is not locked one cent short of it, and pays the headroom's bucket", () => {
    const unlocked = combine({ eodPeakUsd: 51_999.99, eodBalanceUsd: 52_900 });
    expect(budgetOf(unlocked)).toBe(500);
    expect(resolveSessionBudget(unlocked, NOW)).toMatchObject({
      basis: "bucket_500",
      floorUsd: 49_999.99,
    });
  });

  it("floors at min(lockAt, peak - MLL), never max", () => {
    // `max` would put a day-one combine at its own floor with zero headroom.
    expect(resolveSessionBudget(combine({ eodPeakUsd: 50_000 }), NOW).floorUsd).toBe(48_000);
    expect(
      resolveSessionBudget(combine({ eodPeakUsd: 53_000, eodBalanceUsd: 52_000 }), NOW).floorUsd,
    ).toBe(50_000);
  });

  // A96: the stored peak is the highest close on record, so a losing first
  // day seeds it below the start. Topstep's limit trails the highest
  // end-of-day balance including the starting balance, and so does the floor.
  it("trails from the starting balance when every close is below it (A96)", () => {
    expect(
      resolveSessionBudget(combine({ eodPeakUsd: 49_500, eodBalanceUsd: 49_500 }), NOW),
    ).toMatchObject({
      basis: "bucket_350",
      floorUsd: 48_000,
      headroomUsd: 1_500,
      closeUsd: 49_500,
      peakUsd: 50_000,
      posture: { maxRiskPerTradeUsd: 350 },
    });
  });

  it("reports the start as the peak when the recorded peak is exactly the start (A96)", () => {
    expect(resolveSessionBudget(combine({ eodPeakUsd: 50_000 }), NOW)).toMatchObject({
      floorUsd: 48_000,
      peakUsd: 50_000,
    });
  });

  // Before A96 this sized against a $45,900 floor (47,900 - MLL).
  it("refuses a combine whose first close is under the start-trailed floor, which Topstep would already have busted (A96)", () => {
    expect(() =>
      resolveSessionBudget(combine({ eodPeakUsd: 47_900, eodBalanceUsd: 47_900 }), NOW),
    ).toThrow(accountAtFloorRefusal(47_900, 48_000));
  });

  it("trails from the recorded peak once a close is above the start (A96)", () => {
    expect(
      resolveSessionBudget(combine({ eodPeakUsd: 51_500, eodBalanceUsd: 51_500 }), NOW),
    ).toMatchObject({ floorUsd: 49_500, peakUsd: 51_500 });
  });

  it("trails a fresh funded account from its 0 start after a losing first day (A96)", () => {
    expect(
      resolveSessionBudget(funded({ eodPeakUsd: -300, eodBalanceUsd: -300 }), NOW),
    ).toMatchObject({ basis: "funded_flat", floorUsd: -2_000, headroomUsd: 1_700, peakUsd: 0 });
  });

  it("leaves the post-payout floor at 0 and its peak as recorded (A96)", () => {
    expect(
      resolveSessionBudget(
        funded({
          riskPhase: "funded_paid",
          mllUsd: null,
          startBalanceUsd: null,
          eodBalanceUsd: 2_000,
          eodPeakUsd: 2_500,
        }),
        NOW,
      ),
    ).toMatchObject({ basis: "derisk", floorUsd: 0, headroomUsd: 2_000, peakUsd: 2_500 });
  });
});

describe("resolveSessionBudget — funded before the first payout", () => {
  it("pays the flat baseline at every headroom", () => {
    for (let headroom = 1; headroom <= 10_000; headroom++) {
      // A peak at or above the MLL puts the floor on the lock at 0, so the
      // close *is* the headroom.
      const row = funded({
        eodBalanceUsd: headroom,
        eodPeakUsd: Math.max(headroom, COMBINE_MLL_USD),
      });
      expect(resolveSessionBudget(row, NOW).headroomUsd).toBe(headroom);
      expect(budgetOf(row)).toBe(225);
    }
  });

  it("still records the headroom it did not size from", () => {
    expect(resolveSessionBudget(funded({ eodBalanceUsd: 2_000, eodPeakUsd: 2_500 }), NOW)).toMatchObject(
      { basis: "funded_flat", floorUsd: 0, headroomUsd: 2_000 },
    );
  });

  it("is capped by the flat field and never raised by it", () => {
    expect(budgetOf(funded({ maxRiskPerTradeUsd: 300 }))).toBe(225);
    expect(budgetOf(funded({ maxRiskPerTradeUsd: 200 }))).toBe(200);
  });
});

describe("resolveSessionBudget — funded after a payout", () => {
  const paid = (balance: number, over: Partial<SessionBudgetRow> = {}) =>
    funded({
      riskPhase: "funded_paid",
      mllUsd: null,
      startBalanceUsd: null,
      eodBalanceUsd: balance,
      eodPeakUsd: Math.max(balance, 3_000),
      ...over,
    });

  it.each([
    [1_333.33, 100],
    [1_333.34, 100],
    [2_000, 150],
    [2_999.99, 224.99],
    [3_000, 225],
    [8_000, 225],
  ])("scales the balance %s down to $%s", (balance, expected) => {
    expect(budgetOf(paid(balance))).toBe(expected);
  });

  it("reads the balance as the headroom, because the limit reset with the payout", () => {
    expect(resolveSessionBudget(paid(2_000), NOW)).toMatchObject({
      basis: "derisk",
      floorUsd: 0,
      headroomUsd: 2_000,
      closeUsd: 2_000,
    });
  });

  it("is capped by the flat field", () => {
    expect(budgetOf(paid(8_000, { maxRiskPerTradeUsd: 200 }))).toBe(200);
  });

  it("throws on a zero balance", () => {
    expect(() => budgetOf(paid(0))).toThrow(accountAtFloorRefusal(0, 0));
  });
});

describe("resolveSessionBudget — fail-closed", () => {
  it("answers the flat posture and no facts in phase off", () => {
    const off = resolveSessionBudget(combine({ riskPhase: "off", maxRiskPerTradeUsd: 225 }), NOW);
    expect(off).toEqual({
      posture: { maxRiskPerTradeUsd: 225, maxContracts: 3 },
      phase: "off",
      basis: "flat",
      headroomUsd: null,
      floorUsd: null,
      closeUsd: null,
      peakUsd: null,
      sizesSessionStart: null,
    });
  });

  it("answers a null posture for an account with no row, as the flat read does", () => {
    expect(resolveSessionBudget(null, NOW).posture).toBeNull();
  });

  it("takes the lowest budget of the phase when no close is on record", () => {
    const noSample = combine({
      eodBalanceUsd: null,
      eodPeakUsd: null,
      eodSizesSessionStart: null,
    });
    expect(budgetOf(noSample)).toBe(225);
    expect(resolveSessionBudget(noSample, NOW)).toMatchObject({
      basis: "stale_floor",
      floorUsd: null,
      headroomUsd: null,
      sizesSessionStart: null,
    });
  });

  it("takes the lowest budget when the sample sizes an older session", () => {
    // A sample stamped for the previous session is a close the app never took
    // — a holiday, a missed fan-out — and the balance under it may size two
    // buckets high. The once-per-session warn about it is the engine's.
    const stale = combine({
      eodPeakUsd: 51_000,
      eodBalanceUsd: 50_750,
      eodSizesSessionStart: YESTERDAY,
    });
    expect(budgetOf(stale)).toBe(225);
    expect(resolveSessionBudget(stale, NOW)).toMatchObject({
      basis: "stale_floor",
      sizesSessionStart: YESTERDAY,
      closeUsd: 50_750,
    });
  });

  it("reports the recorded peak, not the start, on a stale sample below the start (A96)", () => {
    const stale = combine({
      eodPeakUsd: 49_500,
      eodBalanceUsd: 49_500,
      eodSizesSessionStart: YESTERDAY,
    });
    expect(resolveSessionBudget(stale, NOW)).toMatchObject({
      basis: "stale_floor",
      peakUsd: 49_500,
    });
  });

  it("takes $100, not $225, as the lowest budget after a payout", () => {
    const stale = funded({
      riskPhase: "funded_paid",
      mllUsd: null,
      startBalanceUsd: null,
      eodBalanceUsd: 8_000,
      eodPeakUsd: 8_000,
      eodSizesSessionStart: YESTERDAY,
    });
    expect(budgetOf(stale)).toBe(100);
    expect(resolveSessionBudget(stale, NOW).basis).toBe("stale_floor");
  });

  // The route's own sentence, not a second wording of the same rule: the
  // resolver's throw is rendered verbatim on the Risk block's budget line and
  // in the engine's `entry_blocked` row.
  it("throws on a combine whose loss limit is not the measured one", () => {
    expect(() => budgetOf(combine({ mllUsd: 3_000 }))).toThrow(COMBINE_MLL_REFUSAL);
  });

  // The stale arm is the *sample*'s fallback, not the configuration's. A phase
  // the function cannot price throws whether or not a close happens to be on
  // record, or a row nobody could size would quietly take $225 every day the
  // sampler missed and the doc's "everything else throws" would be false.
  it("throws on a phase it cannot price even with no close on record", () => {
    const noSample = { eodBalanceUsd: null, eodPeakUsd: null, eodSizesSessionStart: null };
    expect(() => budgetOf(combine({ ...noSample, mllUsd: 3_000 }))).toThrow(COMBINE_MLL_REFUSAL);
    expect(() => budgetOf(combine({ ...noSample, startBalanceUsd: null }))).toThrow(
      phaseRuleParameterRefusal("starting balance", null),
    );
    expect(() => budgetOf(funded({ ...noSample, mllUsd: null }))).toThrow(
      phaseRuleParameterRefusal("trailing loss limit", null),
    );
    expect(() => budgetOf(combine({ ...noSample, broker: "tradovate" }))).toThrow(
      NON_TOPSTEP_PHASE_REFUSAL,
    );
  });

  it.each([
    ["the budget", { maxRiskPerTradeUsd: null }],
    ["the ceiling", { maxContracts: null }],
  ])("throws when a phase is set and %s is unset", (_label, over) => {
    expect(() => budgetOf(combine(over))).toThrow(PHASE_NEEDS_RISK_POSTURE_REFUSAL);
  });

  it.each(["combine", "funded_fresh", "funded_paid", "combine_press"] as const)(
    "throws on phase %s on a non-Topstep account",
    (riskPhase) => {
      expect(() => budgetOf(combine({ riskPhase, broker: "tradovate" }))).toThrow(
        NON_TOPSTEP_PHASE_REFUSAL,
      );
    },
  );

  it("throws when a phase that needs the loss limit has none", () => {
    expect(() => budgetOf(funded({ mllUsd: null }))).toThrow(
      phaseRuleParameterRefusal("trailing loss limit", null),
    );
    expect(() => budgetOf(combine({ startBalanceUsd: null }))).toThrow(
      phaseRuleParameterRefusal("starting balance", null),
    );
  });

  // A column set to something unusable is a different fact from one nobody
  // filled in, and the operator checks their own field against the number.
  it("names the unusable value it read, and says 'none set' only for an empty column", () => {
    expect(() => budgetOf(combine({ startBalanceUsd: 0 }))).toThrow(
      phaseRuleParameterRefusal("starting balance", 0),
    );
    expect(phaseRuleParameterRefusal("starting balance", 0)).toContain("$0");
    expect(phaseRuleParameterRefusal("starting balance", null)).toContain("none set");
  });

  // A stored NaN is a column that parsed but is unusable, not one nobody
  // filled in — `requirePositive`/`requireNonNegative` must not fold the two
  // into the same "none set" sentence.
  it("distinguishes a stored non-finite value from an unset column", () => {
    expect(() => budgetOf(combine({ startBalanceUsd: NaN }))).toThrow(
      phaseRuleParameterRefusal("starting balance", "invalid"),
    );
    expect(phaseRuleParameterRefusal("starting balance", "invalid")).not.toContain("none set");
  });

  // The Risk block renders these on its read-only budget line and the engine
  // puts them in `entry_blocked`, so a column name or a mechanism in one is a
  // sentence the operator cannot act on ([docs/modules/ui/copy.md]).
  it("says none of it in column names", () => {
    const sentences = [
      NON_TOPSTEP_PHASE_REFUSAL,
      PHASE_NEEDS_RISK_POSTURE_REFUSAL,
      COMBINE_MLL_REFUSAL,
      phaseRuleParameterRefusal("trailing loss limit", null),
      accountAtFloorRefusal(49_000, 49_000),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/mll_usd|start_balance_usd|risk phase|funded_paid|combine:/);
    }
  });

  it("reads an unrecognised stored phase as off", () => {
    expect(parseAccountRiskPhase(null)).toBe("off");
    expect(parseAccountRiskPhase("combine")).toBe("combine");
    expect(parseAccountRiskPhase("combine_press")).toBe("combine_press");
    expect(parseAccountRiskPhase("funded")).toBe("off");
  });
});

/**
 * The hand-set table in [docs/strategies/accounts/README.md], which the
 * operator runs by hand until the engine wiring lands. The function has to
 * answer what he would have typed, or the two postures diverge silently on
 * the day it takes over.
 */
describe("resolveSessionBudget — reproduces the hand-set table", () => {
  const at = (peak: number, close: number) =>
    budgetOf(combine({ eodPeakUsd: peak, eodBalanceUsd: close }));

  it("pays $500 at a new end-of-day high", () => {
    expect(at(51_000, 51_000)).toBe(500);
  });

  it("pays $350 between $250 and $750 below the peak", () => {
    expect(at(51_000, 50_500)).toBe(350);
  });

  it("pays $225 more than $750 below the peak", () => {
    expect(at(51_000, 50_000)).toBe(225);
  });

  it("pays $225 once the limit has locked at breakeven", () => {
    expect(at(52_000, 52_900)).toBe(225);
  });

  it("pays $225 / $150 / $100 after a payout", () => {
    const paid = (balance: number) =>
      budgetOf(
        funded({
          riskPhase: "funded_paid",
          mllUsd: null,
          startBalanceUsd: null,
          eodBalanceUsd: balance,
          eodPeakUsd: 8_000,
        }),
      );
    expect(paid(3_000)).toBe(225);
    expect(paid(2_000)).toBe(150);
    expect(paid(1_333)).toBe(100);
  });
});

describe("resolveSessionBudget — into the sizer", () => {
  it("carries the row's contract ceiling through untouched", () => {
    expect(resolveSessionBudget(combine({ maxContracts: 2 }), NOW).posture?.maxContracts).toBe(2);
  });

  it("still sizes 3 on a budget that affords 5", () => {
    // MNQ at a 190-tick stop: $96.24 a contract, which $500 buys five of.
    const { posture } = resolveSessionBudget(
      combine({ eodPeakUsd: 51_000, eodBalanceUsd: 50_750 }),
      NOW,
    );
    expect(posture?.maxRiskPerTradeUsd).toBe(500);
    expect(
      resolveRiskSizedContracts({
        slTicks: 190,
        tickValue: 0.5,
        feePerSideUsd: 0.62,
        posture,
        playbook: NO_PLAYBOOK_LIMITS,
        where: "test",
      }),
    ).toMatchObject({ sized: true, contracts: 3 });
  });
});
