/**
 * `classifyAccount` is the Topstep arm of the live-account auto-trade
 * block (`account-trading-policy.ts`), so these are not labelling tests —
 * a wrong answer here either refuses an account the operator trades daily
 * or auto-trades a funded one against Topstep's TOS.
 *
 * The prefixes were confirmed by the operator against their own accounts
 * 2026-08-22, and the first describe below pins three names Topstep
 * actually issued, quoted from docs/bugs.md. The rest are invented and
 * stay invented — they probe the shape and the anchoring, which no single
 * real name can. Keep the two groups apart: the predicate this replaced
 * matched `.includes("COMBINE")`, which no real Combine account contains,
 * and it looked right against invented fixtures alone.
 */

import { describe, it, expect } from "vitest";
import { classifyAccount, PRACTICE_PREFIX } from "./account-classification";

/**
 * Topstep stamps `practice` at its translator (`TopstepClient.searchAccounts`)
 * from `PRACTICE_PREFIX`. Read the exported constant rather than restating
 * the literal: a helper that restates a predicate passes whatever the
 * shipped predicate does, which is how `.includes("COMBINE")` survived.
 * The stamping itself is pinned in `topstep/client.test.ts`.
 */
function topstep(name: string) {
  return { name, practice: name.startsWith(PRACTICE_PREFIX) };
}

/**
 * The three account names below were issued by Topstep to the operator and
 * are recorded verbatim in docs/bugs.md. They are the load-bearing cases:
 * a fixture that does not match an issued name is what let
 * `.includes("COMBINE")` look correct, and the names that would have caught
 * it were already sitting in the repo, unused.
 *
 * Every real name carries a `-V2-` segment the invented fixtures below do
 * not, so these also pin that the prefix match survives it.
 */
describe("classifyAccount — account names Topstep actually issued", () => {
  it("classifies the observed practice account", () => {
    // docs/bugs.md:662
    expect(classifyAccount(topstep("PRAC-V2-100200-90012114"))).toBe("PRAC");
  });

  it("classifies the observed Combine account", () => {
    // docs/bugs.md:840
    expect(classifyAccount(topstep("50KTC-V2-100200-90020038"))).toBe("COMBINE");
  });

  it("classifies the observed ExpressFunded account", () => {
    // docs/bugs.md:876 — a Combine that passed and was reissued as XFA.
    expect(classifyAccount(topstep("EXPRESS-V2-CT-100200-90034064"))).toBe("XFA");
  });
});

describe("classifyAccount — the shape of each prefix", () => {
  // Invented names, on purpose: these probe the shape the predicate
  // accepts rather than any account that exists. `25KTC-` is not a tier
  // Topstep offers — it is here because the size is any run of digits and
  // a new tier must not need a code change.
  it("classifies a practice account from the stamped flag", () => {
    expect(classifyAccount(topstep("PRAC-123456"))).toBe("PRAC");
  });

  it.each(["50KTC-98765", "100KTC-11111", "25KTC-1", "150KTC-42"])(
    "classifies %s as a Combine",
    (name) => {
      expect(classifyAccount(topstep(name))).toBe("COMBINE");
    },
  );

  it("classifies an ExpressFunded account", () => {
    expect(classifyAccount(topstep("EXPRESS-55555"))).toBe("XFA");
  });

  it("falls through to LIVE for a funded account", () => {
    expect(classifyAccount(topstep("FUNDED-42"))).toBe("LIVE");
  });
});

describe("classifyAccount — the prefixes are anchored, not substrings", () => {
  // Substring matching is the permissive direction: it would auto-trade a
  // funded account whose name merely carries the token. The cost of that
  // is a terminated account; the cost of the opposite error is a visible,
  // reportable refusal. These pin the safe direction.
  it.each([
    "FUNDED-50KTC-LEGACY",
    "LIVE-EXPRESS-GRADUATE",
    "GRADUATED-FROM-100KTC",
    "MY-COMBINE-ACCOUNT",
    "XFA-SOMETHING",
  ])("does not classify %s as an evaluation account", (name) => {
    expect(classifyAccount(topstep(name))).toBe("LIVE");
  });

  it("matches case-insensitively, since the check upper-cases first", () => {
    expect(classifyAccount(topstep("50ktc-98765"))).toBe("COMBINE");
    expect(classifyAccount(topstep("express-55555"))).toBe("XFA");
  });

  // The size is any digits, so a new Combine tier does not need a code
  // change — but the `KTC-` shape does.
  it("refuses a Combine-like name that does not match the shape", () => {
    expect(classifyAccount(topstep("50K-98765"))).toBe("LIVE");
    expect(classifyAccount(topstep("KTC-98765"))).toBe("LIVE");
  });
});

describe("classifyAccount — non-Topstep brokers", () => {
  // Tradovate has no eval naming convention; live/demo is host-level and
  // arrives via the stamped `practice` flag.
  it("classifies a Tradovate demo account as PRAC from the flag alone", () => {
    expect(classifyAccount({ name: "DEMO12345", practice: true })).toBe("PRAC");
  });

  it("classifies a Tradovate live account as LIVE", () => {
    expect(classifyAccount({ name: "APEX12345", practice: false })).toBe("LIVE");
  });
});

describe("classifyAccount — surrounding whitespace on a wire name", () => {
  // A leading space made all three checks miss at once. Trimming
  // normalises the input; it accepts no token that was not accepted
  // before.
  it("classifies a space-padded Combine name", () => {
    expect(classifyAccount(topstep(" 50KTC-V2-100200-90020038 "))).toBe("COMBINE");
  });

  it("classifies a space-padded ExpressFunded name", () => {
    expect(classifyAccount(topstep(" EXPRESS-V2-CT-100200-90034064"))).toBe("XFA");
  });

  it("still refuses a name whose prefix only appears after the whitespace run", () => {
    expect(classifyAccount(topstep("FUNDED 50KTC-1"))).toBe("LIVE");
  });
});
