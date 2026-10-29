import { describe, it, expect } from "vitest";

import { agreementOverLabelled } from "./labels-command";

const ACTIVE = "active.expanded";
const QUIET = "quiet.compressed";
const UNKNOWN = "unknown";

describe("agreementOverLabelled", () => {
  it("scores a variant's warmup as excluded rather than as disagreement", () => {
    const base = [ACTIVE, QUIET, ACTIVE, QUIET, ACTIVE];
    // A longer-baseline variant cannot label the first two days; on the days
    // it can, it agrees with the base label everywhere.
    const variant = [UNKNOWN, UNKNOWN, ACTIVE, QUIET, ACTIVE];

    expect(agreementOverLabelled(base, variant)).toEqual({
      agreement: 1,
      comparedDays: 3,
      excludedDays: 2,
    });
  });

  it("excludes a day the base could not label either", () => {
    const base = [UNKNOWN, ACTIVE, QUIET];
    const variant = [ACTIVE, ACTIVE, QUIET];

    expect(agreementOverLabelled(base, variant)).toEqual({
      agreement: 1,
      comparedDays: 2,
      excludedDays: 1,
    });
  });

  it("still counts a real disagreement on a day both could label", () => {
    const base = [ACTIVE, ACTIVE, QUIET, QUIET];
    const variant = [ACTIVE, QUIET, QUIET, UNKNOWN];

    expect(agreementOverLabelled(base, variant)).toEqual({
      agreement: 2 / 3,
      comparedDays: 3,
      excludedDays: 1,
    });
  });
});
