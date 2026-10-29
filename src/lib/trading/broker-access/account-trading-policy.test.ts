/**
 * The auto-trade permission rule. These tests exercise the exported
 * predicate directly — no local reimplementation of the name-prefix or
 * host comparison, because a helper that restates the rule passes
 * whatever the shipped rule does.
 *
 * Every case names its environment. The rule is env-aware since
 * 2026-09-07 (prod unchanged, staging practice-only), and a case that
 * leaves `NEXT_PUBLIC_APP_ENV` unset is asserting against whichever
 * branch the runner happens to land on.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  autoTradeVerdict,
  LIVE_ACCOUNT_REFUSAL,
  STAGING_PRACTICE_ONLY_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
  type AccountTradingIdentity,
} from "./account-trading-policy";
import { PRACTICE_PREFIX } from "@/lib/brokers/topstep/account-classification";

function topstep(
  name: string,
  practice = name.startsWith(PRACTICE_PREFIX),
): AccountTradingIdentity {
  return { name, broker: "topstep", practice };
}

function tradovate(name: string, practice: boolean): AccountTradingIdentity {
  return { name, broker: "tradovate", practice };
}

/**
 * A broker the app does not have yet. The union has two members, so this
 * shape is only reachable through a cast today — it exists to pin the
 * switch's refusing default, which is what a third `BrokerKind` lands on
 * before anyone writes it an arm.
 */
function unknownBroker(name: string, practice: boolean): AccountTradingIdentity {
  return { name, broker: "ninjatrader", practice } as unknown as AccountTradingIdentity;
}

/** Real names, quoted from the accounts in docs/bugs.md. */
const PRAC = "PRAC-V2-100200-90012114";
const COMBINE = "50KTC-V2-100200-90020038";
const EXPRESS = "EXPRESS-V2-CT-100200-90034064";
/**
 * Invented, and deliberately: **no funded account name has ever been
 * observed**, so topstep.md's prefix table records none and this one must
 * never be promoted into it. What makes it a valid LIVE fixture is that it
 * matches none of the three permitted prefixes, which is exactly what
 * `classifyAccount` answers LIVE for.
 */
const LIVE = "TSTX-441122";

function onProd() {
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
}

function onStaging() {
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("autoTradeVerdict — prod, Topstep", () => {
  it("permits a practice account", () => {
    onProd();
    expect(autoTradeVerdict(topstep(PRAC))).toEqual({ permitted: true });
  });

  // `50KTC-` / `100KTC-`, not "COMBINE" — see classifyAccount. Fixtures
  // named "COMBINE-…" passed here while every real Combine account was
  // being classified LIVE.
  it("permits a Combine account", () => {
    onProd();
    expect(autoTradeVerdict(topstep(COMBINE))).toEqual({ permitted: true });
    expect(autoTradeVerdict(topstep("100KTC-11111"))).toEqual({ permitted: true });
  });

  it("permits an ExpressFunded account", () => {
    onProd();
    expect(autoTradeVerdict(topstep(EXPRESS))).toEqual({ permitted: true });
  });

  it("refuses a live account", () => {
    onProd();
    expect(autoTradeVerdict(topstep(LIVE))).toEqual({
      permitted: false,
      reason: LIVE_ACCOUNT_REFUSAL,
    });
  });

  it("refuses a PRAC-named account whose practice flag is false", () => {
    // The flag is stamped at the translator; a name that looks practice
    // with the flag unset is a contradiction, and contradictions refuse.
    onProd();
    expect(autoTradeVerdict(topstep(PRAC, false)).permitted).toBe(false);
  });

  it("permits an unknown broker's practice-flagged account through this name rule (pinned, not endorsed)", () => {
    // Prod has no refusing default. Any broker that is not Tradovate falls
    // through to `classifyAccount`, which answers PRAC off the `practice`
    // flag alone — so a third `BrokerKind` would be auto-traded on prod
    // before anyone wrote it an arm. Pre-existing, deliberately untouched by
    // the staging change, and tracked on docs/punchlist.md.
    //
    // What holds it up today is the union having exactly two members: this
    // input is reachable only through a cast, and staging's switch already
    // refuses it. Widening `BrokerKind` is what makes it real, and this
    // assertion is what turns that into a visible red line.
    onProd();
    expect(autoTradeVerdict(unknownBroker("SIM-1", true))).toEqual({ permitted: true });
  });
});

describe("autoTradeVerdict — prod, Tradovate", () => {
  // Tradovate accounts are cash accounts and are permitted on the live
  // host. The premise is that Tradovate prop firms do not expose the API,
  // so nothing reachable here is governed by a third party's TOS.
  it("permits an account on the live host", () => {
    onProd();
    expect(autoTradeVerdict(tradovate("APEX-778899", false))).toEqual({ permitted: true });
  });

  it("permits a practice-flagged account", () => {
    onProd();
    expect(autoTradeVerdict(tradovate("DEMO123456", true))).toEqual({ permitted: true });
  });

  it("does not let the Topstep name rules reach a Tradovate account", () => {
    // The broker arm must stay ahead of `classifyAccount`. Both of these
    // permit today, so a regression here is silent unless the reason is
    // asserted: `50KTC-` would classify COMBINE and `LIVE-` would classify
    // LIVE, and only one of those is a refusal. Permitted-for-the-wrong-
    // reason survives until someone tightens the Topstep prefixes.
    onProd();
    expect(autoTradeVerdict(tradovate(COMBINE, false))).toEqual({ permitted: true });
    expect(autoTradeVerdict(tradovate("LIVE-ACCOUNT-1", false))).toEqual({ permitted: true });
  });
});

describe("autoTradeVerdict — staging is practice-only", () => {
  it("permits a Topstep practice account", () => {
    onStaging();
    expect(autoTradeVerdict(topstep(PRAC))).toEqual({ permitted: true });
  });

  it("refuses a Combine account, and says it is because of staging", () => {
    // The whole point of the second constant: an operator looking at a
    // Combine on staging must not read that their Combine is a live
    // account, which would send them to the prop firm over an app rule.
    onStaging();
    expect(autoTradeVerdict(topstep(COMBINE))).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
  });

  it("refuses an ExpressFunded account for the same reason", () => {
    onStaging();
    expect(autoTradeVerdict(topstep(EXPRESS))).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
  });

  it("still refuses a live Topstep account as live, not as staging", () => {
    onStaging();
    expect(autoTradeVerdict(topstep(LIVE))).toEqual({
      permitted: false,
      reason: LIVE_ACCOUNT_REFUSAL,
    });
  });

  it("permits a Tradovate account off the demo host", () => {
    // `practice` is stamped from the host the account was fetched off, so
    // true here means demo.
    onStaging();
    expect(autoTradeVerdict(tradovate("DEMO123456", true))).toEqual({ permitted: true });
  });

  it("refuses a Tradovate account not stamped from the demo host", () => {
    // Unreachable while a staging build only ever talks to demo, but a
    // row persisted by a prod build carries `practice: false` and is not
    // evidence of a demo account.
    onStaging();
    expect(autoTradeVerdict(tradovate("APEX-778899", false))).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
  });

  it("refuses a broker with no practice notion, however it is flagged", () => {
    onStaging();
    expect(autoTradeVerdict(unknownBroker("SIM-1", true))).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
    // The unflagged one is refused by the TOS arm before staging is
    // consulted, because that arm falls through to the Topstep name rule
    // for any broker that is not Tradovate — pre-existing, and the prod
    // path is deliberately untouched. Refused either way, which is what
    // this case is pinning; only the sentence differs.
    expect(autoTradeVerdict(unknownBroker("SIM-1", false)).permitted).toBe(false);
  });
});

describe("autoTradeVerdict — the env branch fails to the narrow side", () => {
  // `isStagingEnv()` is everything that is not exactly "prod", so the
  // failure mode of a typo or an unset variable is the practice-only
  // rule, never the prod one.
  it("treats an unset environment as staging", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", undefined);
    expect(autoTradeVerdict(topstep(COMBINE))).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
  });

  it("treats a mistyped environment as staging", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect(autoTradeVerdict(topstep(EXPRESS)).permitted).toBe(false);
  });
});

describe("autoTradeVerdict — unknown account", () => {
  it("refuses when the identity cannot be resolved, on prod", () => {
    onProd();
    expect(autoTradeVerdict(null)).toEqual({
      permitted: false,
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });

  it("refuses an unresolvable identity on staging too, with the same reason", () => {
    // Unclassifiable is recoverable and staging-only is not, so the
    // recoverable wording has to survive the staging branch.
    onStaging();
    expect(autoTradeVerdict(null)).toEqual({
      permitted: false,
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });
});
