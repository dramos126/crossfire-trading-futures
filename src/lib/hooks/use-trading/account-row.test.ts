/**
 * The client's account rows carry the server's auto-trade verdict (bugs.md
 * A38) and narrow it at the boundary: anything that is not a well-formed
 * verdict reads as refused, because the cost of reading it as permitted is a
 * terminated funded account.
 */
import { describe, it, expect } from "vitest";
import { accountAutoTrade, toAccountRows, toVerdict } from "./account-row";
import {
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";

const ROW = { id: 1001, name: "PRAC-V2-100200-90012114", broker: "topstep", practice: true };
const UNVERIFIED = { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL };

describe("toAccountRows", () => {
  it("keeps the server's verdict as it came", () => {
    const [permitted, refused] = toAccountRows([
      { ...ROW, autoTrade: { permitted: true } },
      { ...ROW, id: 1002, autoTrade: { permitted: false, reason: LIVE_ACCOUNT_REFUSAL } },
    ]);
    expect(permitted.autoTrade).toEqual({ permitted: true });
    expect(refused.autoTrade).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
  });

  it("reads a missing or malformed verdict as refused, never permitted", () => {
    const rows = toAccountRows([
      ROW,
      { ...ROW, autoTrade: null },
      { ...ROW, autoTrade: { permitted: "yes" } },
      { ...ROW, autoTrade: { permitted: false } },
      { ...ROW, autoTrade: { permitted: false, reason: " " } },
    ]);
    expect(rows.map((r) => r.autoTrade)).toEqual(Array(5).fill(UNVERIFIED));
  });

  it("drops an element that is not an object", () => {
    expect(toAccountRows([null, "x", 7, ROW]).map((r) => r.id)).toEqual([1001]);
  });
});

describe("toVerdict", () => {
  it("reads a truthy non-boolean `permitted` as refused, never permitted", () => {
    for (const raw of [{ permitted: 1 }, { permitted: "false" }, { permitted: "true" }, {}, undefined, 1]) {
      expect(toVerdict(raw)).toEqual(UNVERIFIED);
    }
  });

  it("keeps a well-formed verdict", () => {
    expect(toVerdict({ permitted: true })).toEqual({ permitted: true });
    expect(toVerdict({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL })).toEqual({ permitted: false, reason: LIVE_ACCOUNT_REFUSAL });
  });
});

describe("accountAutoTrade", () => {
  it("refuses an account the catalogue holds no row for", () => {
    expect(accountAutoTrade(null)).toEqual(UNVERIFIED);
    expect(accountAutoTrade(undefined)).toEqual(UNVERIFIED);
  });

  it("answers the row's own verdict otherwise", () => {
    expect(accountAutoTrade({ autoTrade: { permitted: true } })).toEqual({ permitted: true });
  });
});
