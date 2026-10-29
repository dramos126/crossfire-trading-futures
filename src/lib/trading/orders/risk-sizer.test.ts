/**
 * The throw that is the money guard, moved.
 *
 * `resolveRiskSizedContracts` decides how many contracts go on the wire, and
 * its contract is that **every input it cannot make sense of throws** — the
 * engine catches at the per-leg tick boundary, releases the contract lock,
 * logs and skips, so no order is placed on an undefined size. A default of
 * `1` anywhere in here is a silent wrong-size order. The one non-throwing
 * refusal is the budget itself, which is a `skip` because the next setup's
 * stop may fit.
 */
import { describe, it, expect } from "vitest";
import {
  NO_PLAYBOOK_LIMITS,
  PLAYBOOK_MAX_CONTRACTS_REFUSAL,
  REVIEWED_MAX_CONTRACTS,
  playbookBudgetCents,
  playbookSizingFrom,
  playbookSizingRefusal,
  resolveRiskSizedContracts,
  type AccountRiskPosture,
  type PlaybookSizing,
} from "./risk-sizer";

/** MNQ: $0.50 a tick, $0.62 a side. */
const MNQ = { tickValue: 0.5, feePerSideUsd: 0.62 };

function size(slTicks: number, posture: AccountRiskPosture | null) {
  return resolveRiskSizedContracts({ ...MNQ, slTicks, posture, playbook: NO_PLAYBOOK_LIMITS, where: "test" });
}

const POSTURE: AccountRiskPosture = { maxRiskPerTradeUsd: 225, maxContracts: 10 };

describe("resolveRiskSizedContracts — the count", () => {
  it("fits as many contracts as the budget pays for", () => {
    // 100t × $0.50 + $1.24 = $51.24; floor(225 / 51.24) = 4.
    const r = size(100, POSTURE);
    expect(r).toMatchObject({ sized: true, contracts: 4, riskPerContractUsd: 51.24 });
  });

  it("caps at the account's ceiling even when the budget pays for more", () => {
    // A 10t stop costs $6.24, which the budget buys 36 of.
    expect(size(10, { maxRiskPerTradeUsd: 225, maxContracts: 3 })).toMatchObject({
      sized: true,
      contracts: 3,
    });
  });

  it("counts both sides of the round trip in the per-contract loss", () => {
    // Without the fees a $50.00 stop fits four times over at $200; with
    // them it costs $51.24 and fits three.
    expect(size(100, { maxRiskPerTradeUsd: 205, maxContracts: 10 })).toMatchObject({
      contracts: 4,
    });
    expect(size(100, { maxRiskPerTradeUsd: 204, maxContracts: 10 })).toMatchObject({
      contracts: 3,
    });
  });

  it("is decided at an exact multiple, not lost to float division", () => {
    // The reason the arithmetic is in cents: 3 × $51.24 is exactly $153.72,
    // and 153.72 / 51.24 in doubles is 2.9999999999999996.
    expect(size(100, { maxRiskPerTradeUsd: 153.72, maxContracts: 10 })).toMatchObject({
      contracts: 3,
    });
  });

  it("takes a fractional stop distance without rounding it first", () => {
    // 37.5t × $0.50 = $18.75, + $1.24 = $19.99. The budget pays for 11 and
    // the ceiling holds it at 10, which is both rules in one assertion.
    expect(size(37.5, POSTURE)).toMatchObject({ riskPerContractUsd: 19.99, contracts: 10 });
  });

  it("hands back the posture it sized from", () => {
    const r = size(100, POSTURE);
    expect(r.posture).toEqual(POSTURE);
  });
});

describe("resolveRiskSizedContracts — the budget refusal", () => {
  it("skips rather than throwing when one contract does not fit", () => {
    // 500t × $0.50 + $1.24 = $251.24, over a $225 budget.
    const r = size(500, POSTURE);
    expect(r).toMatchObject({ sized: false, riskPerContractUsd: 251.24 });
  });

  it("skips rather than returning zero contracts", () => {
    const r = size(500, POSTURE);
    expect("contracts" in r).toBe(false);
  });
});

describe("resolveRiskSizedContracts — every misconfigured input throws", () => {
  it("throws when the account has no posture, naming the caller", () => {
    expect(() => size(100, null)).toThrow(/test: no risk posture/);
  });

  const badBudgets: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -50],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];
  for (const [label, value] of badBudgets) {
    it(`throws when the budget is ${label}`, () => {
      expect(() => size(100, { maxRiskPerTradeUsd: value, maxContracts: 5 })).toThrow(
        /maxRiskPerTradeUsd/,
      );
    });
  }

  const badCeilings: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];
  for (const [label, value] of badCeilings) {
    it(`throws when the contract ceiling is ${label}`, () => {
      expect(() => size(100, { maxRiskPerTradeUsd: 225, maxContracts: value })).toThrow(
        /maxContracts/,
      );
    });
  }

  it("throws on a non-positive or non-finite stop distance", () => {
    expect(() => size(0, POSTURE)).toThrow(/slTicks/);
    expect(() => size(-10, POSTURE)).toThrow(/slTicks/);
    expect(() => size(Number.NaN, POSTURE)).toThrow(/slTicks/);
  });

  it("throws on a tick value the contract table could not supply", () => {
    expect(() =>
      resolveRiskSizedContracts({
        slTicks: 100,
        tickValue: 0,
        feePerSideUsd: 0.62,
        posture: POSTURE,
        playbook: NO_PLAYBOOK_LIMITS,
        where: "test",
      }),
    ).toThrow(/tickValue/);
  });

  it("throws on a negative fee rather than crediting it against the budget", () => {
    expect(() =>
      resolveRiskSizedContracts({
        slTicks: 100,
        tickValue: 0.5,
        feePerSideUsd: -1,
        posture: POSTURE,
        playbook: NO_PLAYBOOK_LIMITS,
        where: "test",
      }),
    ).toThrow(/feePerSideUsd/);
  });

  it("throws rather than answering Infinity when the loss rounds to zero cents", () => {
    // Sub-cent stop with fees off: the denominator is 0 and a division
    // would size an unbounded position.
    expect(() =>
      resolveRiskSizedContracts({
        slTicks: 0.001,
        tickValue: 0.5,
        feePerSideUsd: 0,
        posture: POSTURE,
        playbook: NO_PLAYBOOK_LIMITS,
        where: "test",
      }),
    ).toThrow(/rounds to zero/);
  });
});

function sizeFor(slTicks: number, posture: AccountRiskPosture, playbook: PlaybookSizing) {
  return resolveRiskSizedContracts({ ...MNQ, slTicks, posture, playbook, where: "test" });
}

/** Every stop and posture the cases above size, sized again with each spelling
 *  of "no playbook setting". */
const TODAY_CASES: Array<[number, AccountRiskPosture]> = [
  [100, POSTURE],
  [10, { maxRiskPerTradeUsd: 225, maxContracts: 3 }],
  [100, { maxRiskPerTradeUsd: 205, maxContracts: 10 }],
  [100, { maxRiskPerTradeUsd: 204, maxContracts: 10 }],
  [100, { maxRiskPerTradeUsd: 153.72, maxContracts: 10 }],
  [37.5, POSTURE],
  [500, POSTURE],
  [450, { maxRiskPerTradeUsd: 350, maxContracts: 3 }],
  [697, { maxRiskPerTradeUsd: 350, maxContracts: 3 }],
];

describe("resolveRiskSizedContracts — the playbook's own limits", () => {
  it("sizes exactly as today with no playbook setting, however it is spelled", () => {
    for (const [sl, posture] of TODAY_CASES) {
      const today = size(sl, posture);
      expect(sizeFor(sl, posture, NO_PLAYBOOK_LIMITS)).toEqual({ ...today });
      expect(sizeFor(sl, posture, playbookSizingFrom({}))).toEqual(today);
      expect(
        sizeFor(sl, posture, playbookSizingFrom({ playbookMaxContracts: 0, playbookRiskPercent: 100 })),
      ).toEqual(today);
      expect(today.budgetUsd).toBe(posture.maxRiskPerTradeUsd);
    }
  });

  it("caps below what the budget buys", () => {
    // $225 buys 4 at 100t; the playbook says 2.
    expect(sizeFor(100, POSTURE, { maxContracts: 2, riskPercent: 100 })).toMatchObject({
      sized: true,
      contracts: 2,
    });
  });

  it("never raises the count above the account's ceiling", () => {
    // A 10t stop buys 36; the account says 2, the playbook 3.
    expect(
      sizeFor(10, { maxRiskPerTradeUsd: 225, maxContracts: 2 }, { maxContracts: 3, riskPercent: 100 }),
    ).toMatchObject({ contracts: 2 });
  });

  it("never raises the count above what the budget buys", () => {
    // 450t costs $226.24, so $350 buys 1; the playbook's 3 does not lift it.
    expect(
      sizeFor(450, { maxRiskPerTradeUsd: 350, maxContracts: 3 }, { maxContracts: 3, riskPercent: 100 }),
    ).toMatchObject({ contracts: 1 });
  });

  it("scales the budget by the share: 50% of $350 is $175", () => {
    // 100t costs $51.24: $350 buys 6, $175 buys 3.
    const r = sizeFor(100, { maxRiskPerTradeUsd: 350, maxContracts: 10 }, { maxContracts: null, riskPercent: 50 });
    expect(r).toMatchObject({ sized: true, contracts: 3, budgetUsd: 175 });
    expect(r.posture.maxRiskPerTradeUsd).toBe(350);
  });

  it("divides the exported scaled budget, so the notices and the sizer share one figure", () => {
    expect(playbookBudgetCents(350, 50)).toBe(17500);
    expect(playbookBudgetCents(100.01, 33)).toBe(3300);
    expect(playbookBudgetCents(350, 100)).toBe(35000);
  });

  it("floors the scaled budget to the cent, never up", () => {
    // 33% of $100.01 is 3300.33 cents, floored to $33.00.
    expect(
      sizeFor(100, { maxRiskPerTradeUsd: 100.01, maxContracts: 10 }, { maxContracts: null, riskPercent: 33 }),
    ).toMatchObject({ budgetUsd: 33 });
  });

  it("skips, rather than taking one contract, when the scaled budget is below one contract's loss", () => {
    // $350 fits one 450t contract ($226.24); 50% is $175, which does not.
    const r = sizeFor(450, { maxRiskPerTradeUsd: 350, maxContracts: 3 }, { maxContracts: 1, riskPercent: 50 });
    expect(r).toMatchObject({ sized: false, budgetUsd: 175 });
    expect("contracts" in r).toBe(false);
  });

  const badCaps: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["above the reviewed ceiling", REVIEWED_MAX_CONTRACTS + 1],
    ["NaN", Number.NaN],
  ];
  for (const [label, value] of badCaps) {
    it(`throws on a playbook cap that is ${label}`, () => {
      expect(() => sizeFor(100, POSTURE, { maxContracts: value, riskPercent: 100 })).toThrow(/playbook max contracts/);
    });
  }

  const storedBadCaps: Array<[string, unknown]> = [
    ["text", "1"],
    // `null` is the read's own "no cap", so a stored one must not pass as it.
    ["null", null],
    ["a boolean", true],
  ];
  for (const [label, value] of storedBadCaps) {
    it(`throws on a playbook cap stored as ${label} rather than reading it`, () => {
      expect(() => sizeFor(100, POSTURE, playbookSizingFrom({ playbookMaxContracts: value }))).toThrow(
        /playbook max contracts/,
      );
    });
  }

  const badShares: Array<[string, unknown]> = [
    ["zero", 0],
    ["above 100", 101],
    ["fractional", 50.5],
    ["text", "50"],
    ["null", null],
  ];
  for (const [label, value] of badShares) {
    it(`throws on a playbook share that is ${label}`, () => {
      expect(() => sizeFor(100, POSTURE, playbookSizingFrom({ playbookRiskPercent: value }))).toThrow(
        /playbook risk percent/,
      );
    });
  }
});

// The API's conversion ahead of this check is `deployment-settings.test.ts`.
describe("the playbook settings check", () => {
  it("refuses text on the strict check the CLI runs, since the engine does not convert", () => {
    expect(playbookSizingRefusal({ playbookMaxContracts: "1" })).toBe(PLAYBOOK_MAX_CONTRACTS_REFUSAL);
    expect(playbookSizingRefusal({ playbookMaxContracts: 1, playbookRiskPercent: 100 })).toBeNull();
  });
});
