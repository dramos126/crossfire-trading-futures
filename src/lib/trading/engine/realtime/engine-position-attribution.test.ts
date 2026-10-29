/**
 * P2 of docs/proposals/position-lifecycle.md — D-6's attribution rule.
 *
 * The subject is the arithmetic, so the tests drive it through the same
 * accessors production does rather than hand-writing signed integers:
 * `signedSize` for a broker `Position`, `signedSizeForEntrySide` for a
 * trade row's `OrderSide`, and `translatePosition` for Tradovate's `netPos`
 * — because "both brokers agree once translated" is a claim about the
 * translator as much as about the rule, and a test that types `+1` proves
 * neither.
 *
 * The load-bearing case is `shortfall`. Rows two and four of D-6's table
 * both produce a negative `manualSigned` and want opposite responses, so
 * every assertion here checks `kind`, and the two rows are pinned against
 * each other explicitly.
 */

import { describe, it, expect } from "vitest";

import {
  POSITION_TYPE_FLAT,
  POSITION_TYPE_LONG,
  POSITION_TYPE_SHORT,
  signedSize,
  signedSizeForEntrySide,
  type Position,
  type PositionType,
} from "@/lib/brokers/types";
import { translatePosition } from "@/lib/brokers/tradovate/fill-mapping";
import type { TradovatePosition } from "@/lib/brokers/tradovate/types";
import {
  attributePosition,
  describePositionAttribution,
} from "./engine-position-attribution";

const SIDE_BUY = 0;
const SIDE_SELL = 1;

/** Topstep's native representation: unsigned size paired with a type enum. */
function topstepPosition(type: PositionType, size: number): Position {
  return {
    id: 1,
    accountId: 9001,
    contractId: "CON.F.US.MNQ.U25",
    creationTimestamp: "2026-08-24T14:00:00.000Z",
    type,
    size,
    averagePrice: 100,
  };
}

/** Tradovate's native representation: one signed `netPos`, translated at
 *  the broker boundary into the shape above. */
function tradovatePosition(netPos: number): Position {
  const wire: TradovatePosition = {
    id: 1,
    accountId: 9001,
    contractId: 4242,
    netPos,
    avgPrice: 100,
    timestamp: "2026-08-24T14:00:00.000Z",
  };
  return translatePosition(wire);
}

describe("attributePosition — D-6's four rows", () => {
  it("row 1: operator buys 1 alongside an engine long 1 → excess +1", () => {
    const a = attributePosition({
      expectedSigned: signedSizeForEntrySide(SIDE_BUY, 1),
      actualSigned: signedSize(topstepPosition(POSITION_TYPE_LONG, 2)),
    });

    expect(a).toEqual({
      expectedSigned: 1,
      actualSigned: 2,
      manualSigned: 1,
      kind: "excess",
    });
  });

  it("row 2: operator sells 2 against an engine long 1 → excess -2, opposite direction", () => {
    const a = attributePosition({
      expectedSigned: signedSizeForEntrySide(SIDE_BUY, 1),
      actualSigned: signedSize(topstepPosition(POSITION_TYPE_SHORT, 1)),
    });

    expect(a).toEqual({
      expectedSigned: 1,
      actualSigned: -1,
      manualSigned: -2,
      kind: "excess",
    });
  });

  it("row 3: operator long 3 with no engine position → excess +3, wholly manual", () => {
    const a = attributePosition({
      expectedSigned: 0,
      actualSigned: signedSize(topstepPosition(POSITION_TYPE_LONG, 3)),
    });

    expect(a).toEqual({
      expectedSigned: 0,
      actualSigned: 3,
      manualSigned: 3,
      kind: "excess",
    });
  });

  it("row 4: engine ordered 2 and only 1 filled → shortfall -1, NOT manual", () => {
    const a = attributePosition({
      expectedSigned: signedSizeForEntrySide(SIDE_BUY, 2),
      actualSigned: signedSize(topstepPosition(POSITION_TYPE_LONG, 1)),
    });

    expect(a).toEqual({
      expectedSigned: 2,
      actualSigned: 1,
      manualSigned: -1,
      kind: "shortfall",
    });
  });

  it("does not classify on the sign of manualSigned — rows 2 and 4 are both negative and opposite", () => {
    const crossedThrough = attributePosition({ expectedSigned: 1, actualSigned: -1 });
    const partiallyFilled = attributePosition({ expectedSigned: 2, actualSigned: 1 });

    expect(crossedThrough.manualSigned).toBeLessThan(0);
    expect(partiallyFilled.manualSigned).toBeLessThan(0);
    expect(crossedThrough.kind).toBe("excess");
    expect(partiallyFilled.kind).toBe("shortfall");
  });
});

describe("attributePosition — the shortfall arm", () => {
  it("calls a broker gone flat under a live engine position a shortfall, not a manual close", () => {
    const a = attributePosition({
      expectedSigned: signedSizeForEntrySide(SIDE_BUY, 1),
      actualSigned: 0,
    });

    expect(a.manualSigned).toBe(-1);
    expect(a.kind).toBe("shortfall");
  });

  it("treats every unfilled remainder short of the order as a shortfall", () => {
    for (const filled of [0, 1, 2, 3]) {
      expect(attributePosition({ expectedSigned: 4, actualSigned: filled }).kind).toBe("shortfall");
    }
  });

  it("stops being a shortfall the moment the position crosses zero", () => {
    expect(attributePosition({ expectedSigned: 4, actualSigned: 0 }).kind).toBe("shortfall");
    expect(attributePosition({ expectedSigned: 4, actualSigned: -1 }).kind).toBe("excess");
  });

  it("mirrors on the short side — a partial fill of a short entry cannot overshoot either", () => {
    expect(attributePosition({ expectedSigned: -2, actualSigned: -1 }).kind).toBe("shortfall");
    expect(attributePosition({ expectedSigned: -2, actualSigned: -3 }).kind).toBe("excess");
    expect(attributePosition({ expectedSigned: -2, actualSigned: 1 }).kind).toBe("excess");
  });
});

describe("attributePosition — flat", () => {
  it("is aligned when both sides are flat", () => {
    expect(attributePosition({ expectedSigned: 0, actualSigned: 0 })).toEqual({
      expectedSigned: 0,
      actualSigned: 0,
      manualSigned: 0,
      kind: "aligned",
    });
  });

  it("reads a Tradovate flat frame as 0, labelled flat (bugs.md A41)", () => {
    const flat = tradovatePosition(0);

    expect(flat.type).toBe(POSITION_TYPE_FLAT);
    expect(attributePosition({ expectedSigned: 0, actualSigned: signedSize(flat) }).kind).toBe(
      "aligned",
    );
  });
});

describe("attributePosition — both brokers' representations", () => {
  it("agrees on a long, whether the broker reported type+size or a signed netPos", () => {
    const topstep = signedSize(topstepPosition(POSITION_TYPE_LONG, 2));
    const tradovate = signedSize(tradovatePosition(2));

    expect(tradovate).toBe(topstep);
    expect(attributePosition({ expectedSigned: 1, actualSigned: tradovate })).toEqual(
      attributePosition({ expectedSigned: 1, actualSigned: topstep }),
    );
  });

  it("agrees on a short, which is where a magnitude-only comparison diverges", () => {
    const topstep = signedSize(topstepPosition(POSITION_TYPE_SHORT, 1));
    const tradovate = signedSize(tradovatePosition(-1));

    expect(tradovate).toBe(-1);
    expect(tradovate).toBe(topstep);
    // The whole reason D-6 insists on direction: `size` alone reads 1 === 1.
    expect(tradovatePosition(-1).size).toBe(topstepPosition(POSITION_TYPE_LONG, 1).size);
    expect(attributePosition({ expectedSigned: 1, actualSigned: tradovate }).kind).toBe("excess");
  });

  it("bridges a trade row's OrderSide without a cast — sell 1 is short 1, not long 1", () => {
    expect(signedSizeForEntrySide(SIDE_SELL, 1)).toBe(-1);
    expect(
      attributePosition({
        expectedSigned: signedSizeForEntrySide(SIDE_SELL, 1),
        actualSigned: signedSize(tradovatePosition(-1)),
      }).kind,
    ).toBe("aligned");
  });
});

describe("describePositionAttribution", () => {
  it("names an aligned pair without a manual quantity", () => {
    expect(describePositionAttribution(attributePosition({ expectedSigned: 1, actualSigned: 1 })))
      .toBe("engine expects Long 1, broker reports Long 1 — aligned");
  });

  it("names the excess", () => {
    expect(describePositionAttribution(attributePosition({ expectedSigned: 1, actualSigned: 2 })))
      .toBe("engine expects Long 1, broker reports Long 2 — manual +1 (excess)");
  });

  it("says a crossed position has put the protective stop on the wrong side", () => {
    const line = describePositionAttribution(
      attributePosition({ expectedSigned: 1, actualSigned: -1 }),
    );

    expect(line).toContain("engine expects Long 1, broker reports Short 1 — manual -2");
    expect(line).toContain("opposite direction");
  });

  it("calls an expected-flat position wholly manual", () => {
    expect(describePositionAttribution(attributePosition({ expectedSigned: 0, actualSigned: 3 })))
      .toBe("engine expects flat, broker reports Long 3 — manual +3 (excess, wholly manual)");
  });

  it("says outright that a shortfall is not attributable, so the line cannot be read as a manual sell", () => {
    const line = describePositionAttribution(
      attributePosition({ expectedSigned: 2, actualSigned: 1 }),
    );

    expect(line).toContain("engine expects Long 2, broker reports Long 1 — manual -1");
    expect(line).toContain("shortfall");
    expect(line).toContain("not attributable");
    expect(line).not.toContain("excess");
  });
});
