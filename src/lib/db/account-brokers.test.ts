/**
 * `account_brokers` as the persisted account catalog: the broker
 * discriminator it always held, plus the name/practice pair the
 * live-account auto-trade block classifies on.
 *
 * Real in-memory better-sqlite3 with the shipped migration replayed off
 * the mocked `registerMigration`, per the pattern in
 * `tradovate-order-map.test.ts` — restating the schema here would let the
 * shipped `ALTER TABLE` drift away from the one under test, and the whole
 * point of these tests is that a row without a name is refused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

import {
  LIVE_ACCOUNT_REFUSAL,
  STAGING_PRACTICE_ONLY_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";
import {
  BrokerKind,
  autoTradeVerdictForAccountId,
  autoTradeVerdictsForAccountIds,
  autoTradeVerdictsOrUnverified,
  carryRiskSettings,
  getAccountRiskSettings,
  logAccountRiskChange,
  getAccountBrokerOrNull,
  getAccountDeployState,
  getAccountBrokerOrTopstep,
  getAccountDailyPnlLimits,
  getAccountRiskPhase,
  getAccountRiskPosture,
  getAccountTradingIdentity,
  listAccountBalances,
  listAccountRiskPostures,
  accountStatesFromSearch,
  recordAccountBalances,
  getBrokerAccountFacts,
  markAccountsActive,
  newlyDeadOf,
  recordAccountStates,
  recordSessionClose,
  resolveSessionPosture,
  screenAccountsForAutoTrade,
  setAccountBroker,
  setAccountBrokers,
  setAccountDailyPnlLimits,
  setAccountRiskPhase,
  setAccountRiskPosture,
  toAccountBrokerSeeds,
  type AccountBrokerSeed,
  type AccountStateAnswer,
  type BrokerAccountFacts,
} from "./account-brokers";
import { getTradeById, insertPendingEntry } from "./trades";
import { log } from "@/lib/logger";
import { describeAccountRiskChange } from "./account-risk-change";
import {
  ACCOUNT_DEAD_REFUSAL,
  AUTO_OCO_OFF_REFUSAL,
  AUTO_OCO_UNKNOWN_REFUSAL,
  lockedRefusal,
} from "@/lib/trading/broker-access/account-state-gate";
import { accountEntrySkip } from "@/lib/trading/engine/engine-account-entry-gate";
import { REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import { COMBINE_MLL_USD } from "@/lib/trading/orders/account-phase-sizer";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import type { Account } from "@/lib/brokers/types";

function seed(over: Partial<AccountBrokerSeed> = {}): AccountBrokerSeed {
  return {
    accountId: 1,
    broker: BrokerKind.Topstep,
    name: "PRAC-V2-12345",
    practice: true,
    ...over,
  };
}

/** A row as written before `account_name` / `practice` existed. */
function insertLegacyRow(accountId: number, broker: string): void {
  db.prepare(
    `INSERT INTO account_brokers (account_id, broker, updated_at) VALUES (?, ?, ?)`,
  ).run(accountId, broker, new Date().toISOString());
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the migration", () => {
  it("adds account_name and practice to a table that predates them", () => {
    const fresh = new Database(":memory:");
    fresh.exec(`
      CREATE TABLE account_brokers (
        account_id INTEGER PRIMARY KEY,
        broker TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    fresh
      .prepare(`INSERT INTO account_brokers VALUES (?, ?, ?)`)
      .run(7, "topstep", new Date().toISOString());
    for (const fn of migrations) fn(fresh);
    const cols = (fresh.prepare(`PRAGMA table_info(account_brokers)`).all() as Array<{
      name: string;
    }>).map((c) => c.name);
    expect(cols).toContain("account_name");
    expect(cols).toContain("practice");
    const row = fresh.prepare(`SELECT * FROM account_brokers WHERE account_id = 7`).get() as {
      account_name: string | null;
      practice: number | null;
    };
    expect(row.account_name).toBeNull();
    expect(row.practice).toBeNull();
  });

  it("is idempotent across repeated boots", () => {
    for (const fn of migrations) fn(db);
    for (const fn of migrations) fn(db);
    const cols = (db.prepare(`PRAGMA table_info(account_brokers)`).all() as Array<{
      name: string;
    }>).filter((c) => c.name === "account_name");
    expect(cols).toHaveLength(1);
  });
});

describe("setAccountBrokers / getAccountTradingIdentity", () => {
  it("round-trips name, broker and practice", () => {
    setAccountBrokers([seed({ accountId: 42, name: "EXPRESS-98765", practice: false })]);
    expect(getAccountTradingIdentity(42)).toEqual({
      name: "EXPRESS-98765",
      broker: "topstep",
      practice: false,
    });
  });

  it("upserts an existing row rather than duplicating it", () => {
    setAccountBrokers([seed({ accountId: 42, name: "PRAC-OLD" })]);
    setAccountBrokers([seed({ accountId: 42, name: "PRAC-NEW" })]);
    expect(getAccountTradingIdentity(42)?.name).toBe("PRAC-NEW");
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM account_brokers`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("writes the whole seed through the single-account variant too", () => {
    setAccountBroker(seed({ accountId: 9, broker: BrokerKind.Tradovate, name: "DEMO9" }));
    expect(getAccountTradingIdentity(9)).toEqual({
      name: "DEMO9",
      broker: "tradovate",
      practice: true,
    });
  });

  it("returns null for an account with no row", () => {
    expect(getAccountTradingIdentity(999)).toBeNull();
  });

  it("returns null for a row seeded before the name column existed", () => {
    insertLegacyRow(5, "topstep");
    expect(getAccountTradingIdentity(5)).toBeNull();
  });

  it("still routes a legacy row's broker lookup", () => {
    insertLegacyRow(5, "tradovate");
    expect(getAccountBrokerOrNull(5)).toBe(BrokerKind.Tradovate);
    expect(getAccountBrokerOrTopstep(5)).toBe(BrokerKind.Tradovate);
  });
});

describe("autoTradeVerdictForAccountId", () => {
  // The rule is env-aware, so the evaluation classes are asserted on the
  // environment that permits them. The staging narrowing has its own
  // block below; what is being tested here is that the adapter carries
  // whatever the predicate answers.
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  });

  it("permits a Topstep practice account", () => {
    setAccountBrokers([seed({ accountId: 1, name: "PRAC-V2-12345", practice: true })]);
    expect(autoTradeVerdictForAccountId(1)).toEqual({ permitted: true });
  });

  it("permits a Topstep ExpressFunded account", () => {
    setAccountBrokers([seed({ accountId: 2, name: "EXPRESS-98765", practice: false })]);
    expect(autoTradeVerdictForAccountId(2)).toEqual({ permitted: true });
  });

  it("permits a Topstep Combine account", () => {
    setAccountBrokers([seed({ accountId: 3, name: "50KTC-55555", practice: false })]);
    expect(autoTradeVerdictForAccountId(3)).toEqual({ permitted: true });
  });

  it("refuses a Topstep live account", () => {
    setAccountBrokers([seed({ accountId: 4, name: "TSTX-441122", practice: false })]);
    expect(autoTradeVerdictForAccountId(4)).toEqual({
      permitted: false,
      reason: LIVE_ACCOUNT_REFUSAL,
    });
  });

  it("refuses an account with no row", () => {
    expect(autoTradeVerdictForAccountId(999)).toEqual({
      permitted: false,
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });

  it("refuses a row that carries no name", () => {
    insertLegacyRow(5, "topstep");
    expect(autoTradeVerdictForAccountId(5)).toEqual({
      permitted: false,
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });

  it("permits a Tradovate account on the live host — cash account", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    setAccountBrokers([
      seed({ accountId: 6, broker: BrokerKind.Tradovate, name: "APEX-778899", practice: false }),
    ]);
    expect(autoTradeVerdictForAccountId(6)).toEqual({ permitted: true });
  });

  it("permits a Tradovate account on the demo host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    setAccountBrokers([
      seed({ accountId: 6, broker: BrokerKind.Tradovate, name: "DEMO778899", practice: true }),
    ]);
    expect(autoTradeVerdictForAccountId(6)).toEqual({ permitted: true });
  });

  it("carries the staging refusal through to the persisted-state adapter", () => {
    // The adapter has no rule of its own — this is the one assertion that
    // the staging narrowing reaches the server gates that read the table,
    // not just the callers holding an in-memory identity.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    setAccountBrokers([seed({ accountId: 7, name: "50KTC-V2-100200-90020038", practice: false })]);
    expect(autoTradeVerdictForAccountId(7)).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
    expect(autoTradeVerdictsForAccountIds([7]).get(7)).toEqual({
      permitted: false,
      reason: STAGING_PRACTICE_ONLY_REFUSAL,
    });
  });
});

describe("screenAccountsForAutoTrade", () => {
  beforeEach(() => {
    // The Combine in this fixture is a permitted account, which is only
    // true on prod — the summary being tested is over reasons, not over
    // the environment rule.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    setAccountBrokers([
      seed({ accountId: 1, name: "PRAC-V2-12345", practice: true }),
      seed({ accountId: 2, name: "50KTC-55555", practice: false }),
      seed({ accountId: 3, name: "TSTX-441122", practice: false }),
      seed({ accountId: 4, name: "TSTX-990011", practice: false }),
    ]);
    // Every Topstep account read off the website as ok with OCO on, so the
    // account-state gate permits and the live-account cases below are about
    // the live-account block alone.
    recordTopstep([1, 2, 3, 4].map((accountId) => websiteAccount({ accountId })));
  });

  it("returns null when every account may be auto-traded", () => {
    expect(screenAccountsForAutoTrade([1, 2])).toBeNull();
  });

  it("returns null for an empty selection", () => {
    expect(screenAccountsForAutoTrade([])).toBeNull();
  });

  it("refuses a single live account with the reason verbatim", () => {
    const refusal = screenAccountsForAutoTrade([3]);
    expect(refusal).not.toBeNull();
    expect(refusal?.message).toBe(LIVE_ACCOUNT_REFUSAL);
    expect(refusal?.refused).toEqual([{ accountId: 3, reason: LIVE_ACCOUNT_REFUSAL }]);
  });

  it("refuses the whole selection when one of several accounts is live", () => {
    const refusal = screenAccountsForAutoTrade([1, 2, 3]);
    expect(refusal?.refused).toEqual([{ accountId: 3, reason: LIVE_ACCOUNT_REFUSAL }]);
  });

  it("counts the refusals in the message when more than one is refused", () => {
    const refusal = screenAccountsForAutoTrade([1, 3, 4]);
    expect(refusal?.refused).toHaveLength(2);
    expect(refusal?.message).toContain("2 of 3");
    expect(refusal?.message).toContain(LIVE_ACCOUNT_REFUSAL);
  });

  it("refuses an account with no catalog row alongside a live one", () => {
    const refusal = screenAccountsForAutoTrade([777, 3]);
    expect(refusal?.refused).toEqual([
      { accountId: 777, reason: UNVERIFIED_ACCOUNT_REFUSAL },
      { accountId: 3, reason: LIVE_ACCOUNT_REFUSAL },
    ]);
  });

  it("carries both reasons when they differ, so the recoverable one is visible", () => {
    // Showing only the first refusal tells the operator to give up on an
    // account a dashboard reload would fix.
    const refusal = screenAccountsForAutoTrade([777, 3]);
    expect(refusal?.message).toContain(UNVERIFIED_ACCOUNT_REFUSAL);
    expect(refusal?.message).toContain(LIVE_ACCOUNT_REFUSAL);
  });

  it("does not say the operator selected anything", () => {
    // Reached from a group toggle, where nothing was selected.
    expect(screenAccountsForAutoTrade([1, 3, 4])?.message).not.toContain("selected");
  });

  it("states one reason once when several accounts share it", () => {
    const message = screenAccountsForAutoTrade([3, 4])?.message ?? "";
    expect(message).toContain("2 of 2");
    expect(message.split(LIVE_ACCOUNT_REFUSAL)).toHaveLength(2);
  });

  // The account-state gate, asked after the live-account block passes. Every
  // deploy route and the book reconciler call this screen, so these are the
  // server half of each refusal for all of them.
  describe("the account-state gate", () => {
    const LATER = "2099-01-01T00:00:00.000Z";

    it("refuses a dead account with the dead sentence", () => {
      recordTopstep([1, 3, 4].map((accountId) => websiteAccount({ accountId })), LATER);
      expect(screenAccountsForAutoTrade([2])).toEqual({
        message: ACCOUNT_DEAD_REFUSAL,
        refused: [{ accountId: 2, reason: ACCOUNT_DEAD_REFUSAL }],
      });
    });

    it("refuses a locked account until its lockout ends, and not after", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-10-14T15:00:00.000Z"));
        recordTopstep(
          [
            websiteAccount({
              accountId: 2,
              state: "locked",
              lockoutReason: "Daily Loss Limit",
              lockoutUntil: "2026-10-14T21:00:00.000Z",
            }),
            ...[1, 3, 4].map((accountId) => websiteAccount({ accountId })),
          ],
          LATER,
        );
        const reason = lockedRefusal("Daily Loss Limit", new Date("2026-10-14T21:00:00.000Z"));
        expect(screenAccountsForAutoTrade([2])?.message).toBe(reason);
        expect(reason).toContain("Daily Loss Limit");

        vi.setSystemTime(new Date("2026-10-14T21:00:01.000Z"));
        expect(screenAccountsForAutoTrade([2])).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a Topstep account whose Auto OCO Brackets is off, in the operator's sentence", () => {
      recordTopstep(
        [
          websiteAccount({ accountId: 2, facts: { ...COMBINE_FACTS, autoOcoBrackets: false } }),
          ...[1, 3, 4].map((accountId) => websiteAccount({ accountId })),
        ],
        LATER,
      );
      expect(screenAccountsForAutoTrade([2])?.message).toBe(AUTO_OCO_OFF_REFUSAL);
    });

    it("refuses a Topstep account whose OCO setting is unknown — a search fallback", () => {
      recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([1, 2, 3, 4], []), LATER);
      expect(getBrokerAccountFacts(2)).toBeNull();
      expect(screenAccountsForAutoTrade([2])?.message).toBe(AUTO_OCO_UNKNOWN_REFUSAL);
    });

    it("refuses a Topstep account never checked at all, as unknown", () => {
      setAccountBrokers([seed({ accountId: 5, name: "50KTC-77777", practice: false })]);
      expect(screenAccountsForAutoTrade([5])?.message).toBe(AUTO_OCO_UNKNOWN_REFUSAL);
    });

    it("never refuses a Tradovate account on OCO — it has no such setting", () => {
      setAccountBrokers([
        seed({ accountId: 6, broker: BrokerKind.Tradovate, name: "DEMO6", practice: true }),
      ]);
      // Never checked: OCO NULL. Then checked off its search: OCO still NULL.
      expect(screenAccountsForAutoTrade([6])).toBeNull();
      recordAccountStates(BrokerKind.Tradovate, accountStatesFromSearch([6], []), LATER);
      expect(screenAccountsForAutoTrade([6])).toBeNull();
    });

    it("permits an account whose Topstep auto bracket is on — that is a warning, never a refusal", () => {
      recordTopstep(
        [
          websiteAccount({
            accountId: 2,
            facts: {
              ...COMBINE_FACTS,
              bracketAutoApply: true,
              bracketAmountToRiskUsd: 300,
              bracketAmountToMakeUsd: 600,
            },
          }),
          ...[1, 3, 4].map((accountId) => websiteAccount({ accountId })),
        ],
        LATER,
      );
      expect(screenAccountsForAutoTrade([2])).toBeNull();
    });

    it("answers the live-account sentence first on a live account that is also dead", () => {
      recordTopstep([1, 2].map((accountId) => websiteAccount({ accountId })), LATER);
      expect(screenAccountsForAutoTrade([3])?.message).toBe(LIVE_ACCOUNT_REFUSAL);
    });
  });
});

/** One Topstep website answer covering every account it names; a catalogued
 *  Topstep account it leaves out is recorded dead. */
function recordTopstep(accounts: AccountStateAnswer[], at = "2026-10-14T20:00:00.000Z"): void {
  recordAccountStates(BrokerKind.Topstep, { source: "website", accounts }, at);
}

describe("autoTradeVerdictsForAccountIds — on prod", () => {
  beforeEach(() => {
    // The batch adapter carries whatever the predicate answers, and the
    // predicate is env-aware. Both fixtures below answer the same on either
    // branch, so an unpinned environment would hide a batch path that only
    // agreed with the per-account one on the branch the runner landed on.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    setAccountBrokers([
      seed({ accountId: 1, name: "PRAC-V2-12345", practice: true }),
      seed({ accountId: 3, name: "TSTX-441122", practice: false }),
    ]);
  });

  it("answers identically to the per-account adapter", () => {
    const ids = [1, 3, 777];
    const batch = autoTradeVerdictsForAccountIds(ids);
    for (const id of ids) {
      expect(batch.get(id)).toEqual(autoTradeVerdictForAccountId(id));
    }
  });

  it("returns an entry for every id asked, including ones with no row", () => {
    const batch = autoTradeVerdictsForAccountIds([1, 3, 777]);
    expect([...batch.keys()].sort()).toEqual([1, 3, 777]);
    expect(batch.get(777)).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
  });

  it("collapses repeated ids and handles an empty batch", () => {
    expect(autoTradeVerdictsForAccountIds([3, 3, 3]).size).toBe(1);
    expect(autoTradeVerdictsForAccountIds([]).size).toBe(0);
  });

  it("refuses a legacy row with no name, like the per-account path", () => {
    insertLegacyRow(9, "topstep");
    expect(autoTradeVerdictsForAccountIds([9]).get(9)).toEqual({
      permitted: false,
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });
});

describe("autoTradeVerdictsOrUnverified — the reporting surfaces' fail-closed read", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    setAccountBrokers([seed({ accountId: 1, name: "PRAC-V2-12345", practice: true })]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("answers the batch adapter's verdict, and unverified for an id it was not asked", () => {
    const verdictFor = autoTradeVerdictsOrUnverified([1, 777], "api.test");
    expect(verdictFor(1)).toEqual({ permitted: true });
    expect(verdictFor(777)).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
    expect(verdictFor(5)).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
  });

  it("refuses every id as unverified when the read throws, said once under the caller's tag", () => {
    const event = vi.spyOn(log, "event").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("database is locked");
    });

    const verdictFor = autoTradeVerdictsOrUnverified([1], "api.test");

    expect(verdictFor(1)).toEqual({ permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL });
    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith("db_error", "api.test", expect.stringContaining("database is locked"));
  });
});

/**
 * The risk posture. Three of these are properties the module stated in a
 * JSDoc with nothing enforcing them — each fails silently, and the first
 * symptom of any of them is an entry signal arriving at a sizer that throws.
 */
describe("the risk posture", () => {
  const POSTURE = { maxRiskPerTradeUsd: 250, maxContracts: 3 };

  it("survives the seed upsert every boot and page load re-runs", () => {
    setAccountBrokers([seed({ accountId: 42, name: "50KTC-55555", practice: false })]);
    setAccountRiskPosture(42, POSTURE);

    // What `/api/accounts`, `runBootSequence` and `BrokerRegistry.refresh()`
    // each do with a `searchAccounts` response that knows nothing about risk.
    // An `excluded.max_risk_per_trade_usd` in UPSERT_SQL nulls the budget here.
    setAccountBrokers([seed({ accountId: 42, name: "50KTC-55555", practice: false })]);
    expect(getAccountRiskPosture(42)).toEqual(POSTURE);

    setAccountBroker(seed({ accountId: 42, name: "50KTC-55555", practice: false }));
    expect(getAccountRiskPosture(42)).toEqual(POSTURE);
  });

  it("refuses a posture for an account the catalogue has never seen", () => {
    expect(setAccountRiskPosture(777, POSTURE)).toBe(false);
    expect(getAccountRiskPosture(777)).toBeNull();
    // An INSERT here would create a row with no name, which is the shape the
    // live-account block refuses — arriving through the settings form.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM account_brokers`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("reads a half-written row as unset rather than as a posture", () => {
    setAccountBrokers([seed({ accountId: 8 }), seed({ accountId: 9 })]);
    db.prepare(`UPDATE account_brokers SET max_risk_per_trade_usd = 250 WHERE account_id = 8`).run();
    db.prepare(`UPDATE account_brokers SET max_contracts = 3 WHERE account_id = 9`).run();

    expect(getAccountRiskPosture(8)).toBeNull();
    expect(getAccountRiskPosture(9)).toBeNull();
    const listed = listAccountRiskPostures();
    expect(listed.find((r) => r.accountId === 8)?.posture).toBeNull();
    expect(listed.find((r) => r.accountId === 9)?.posture).toBeNull();
  });

  // The ceiling's value is reviewed while its storage stays per account, so a
  // row written when the reviewed number was higher is brought under it at
  // boot. Clamping at *read* instead would leave the form showing a number the
  // sizer does not use.
  it("brings a stored ceiling above the reviewed one down, and leaves the rest alone", () => {
    setAccountBrokers([seed({ accountId: 8 }), seed({ accountId: 9 }), seed({ accountId: 10 })]);
    setAccountRiskPosture(8, { maxRiskPerTradeUsd: 250, maxContracts: 1 });
    setAccountRiskPosture(9, { maxRiskPerTradeUsd: 250, maxContracts: 1 });
    // Above the ceiling, which the route refuses — the shape a row written
    // before the ceiling was reviewed has.
    db.prepare(`UPDATE account_brokers SET max_contracts = 10 WHERE account_id = 9`).run();

    for (const fn of migrations) fn(db);

    expect(getAccountRiskPosture(9)?.maxContracts).toBe(REVIEWED_MAX_CONTRACTS);
    expect(getAccountRiskPosture(8)?.maxContracts).toBe(1);
    // NULL is "no posture", not a ceiling of zero: `NULL > 3` is NULL, so the
    // clamp cannot arm an account the operator never configured.
    expect(getAccountRiskPosture(10)).toBeNull();
  });

  it("round-trips a whole posture and clears it with null", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    expect(setAccountRiskPosture(8, POSTURE)).toBe(true);
    expect(getAccountRiskPosture(8)).toEqual(POSTURE);
    expect(setAccountRiskPosture(8, null)).toBe(true);
    expect(getAccountRiskPosture(8)).toBeNull();
    // Clearing the posture must not evict the row the catalogue owns.
    expect(getAccountTradingIdentity(8)?.name).toBe("PRAC-V2-12345");
  });
});

/**
 * The daily P&L gate, re-scoped from the deployment to the account. It reads
 * the *opposite* way to the posture above — unset is "no gate", not a refusal —
 * so the pair of readings is what these pin.
 */
describe("the daily P&L gate", () => {
  const LIMITS = {
    dailyMaxLossUsd: 675,
    dailyMaxProfitUsd: 1000,
    dailyPnlIncludeUnrealized: true,
  };

  it("reads an account with nothing set as no gate at all, not as a refusal", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    expect(getAccountDailyPnlLimits(8)).toEqual({
      dailyMaxLossUsd: 0,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: false,
    });
  });

  it("reads an account with no row at all the same way", () => {
    // A missing budget stops the account; a missing daily limit is the
    // operator not asking for one. Blocking here would halt an account on a
    // setting nobody touched.
    expect(getAccountDailyPnlLimits(777)).toEqual({
      dailyMaxLossUsd: 0,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: false,
    });
  });

  it("takes one side without the other — the fields are independent", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountDailyPnlLimits(8, {
      dailyMaxLossUsd: 500,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: false,
    });
    expect(getAccountDailyPnlLimits(8)).toEqual({
      dailyMaxLossUsd: 500,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: false,
    });
  });

  it("round-trips every field and clears with null", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    expect(setAccountDailyPnlLimits(8, LIMITS)).toBe(true);
    expect(getAccountDailyPnlLimits(8)).toEqual(LIMITS);
    expect(setAccountDailyPnlLimits(8, null)).toBe(true);
    expect(getAccountDailyPnlLimits(8).dailyMaxLossUsd).toBe(0);
    expect(getAccountTradingIdentity(8)?.name).toBe("PRAC-V2-12345");
  });

  it("refuses an account the catalogue has never seen, and inserts nothing", () => {
    expect(setAccountDailyPnlLimits(777, LIMITS)).toBe(false);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM account_brokers`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("survives the seed upsert every boot and page load re-runs", () => {
    // A nulled daily loss limit is a gate that stops firing, which looks like
    // a good day — the quietest way for UPSERT_SQL to name a posture column.
    setAccountBrokers([seed({ accountId: 42 })]);
    setAccountDailyPnlLimits(42, LIMITS);
    setAccountBrokers([seed({ accountId: 42 })]);
    expect(getAccountDailyPnlLimits(42)).toEqual(LIMITS);
  });

  it("is on the listing the Settings block renders", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountDailyPnlLimits(8, LIMITS);
    expect(listAccountRiskPostures().find((r) => r.accountId === 8)?.dailyPnl).toEqual(LIMITS);
  });
});

/**
 * The account phase and the close sample. Nine columns, two writers and one
 * rule that fails silently in both directions: the seed upsert must never
 * name any of them, and the app must never lose the payout stamp.
 */
describe("the account risk phase", () => {
  /** Wednesday 2026-09-09, 10:00 ET — inside the session that opened Tuesday
   *  18:00 ET, which is what a close taken at Tuesday's 17:00 close stamps. */
  const NOW = new Date("2026-09-09T14:00:00.000Z");
  const TODAY = currentCmeSessionStart(NOW);
  const COMBINE = {
    phase: "combine" as const,
    mllUsd: COMBINE_MLL_USD,
    startBalanceUsd: 50_000,
    pressAtUsd: null,
  };
  const PRESS = { ...COMBINE, phase: "combine_press" as const, pressAtUsd: 1_500 };

  function phaseColumns(accountId: number) {
    return db
      .prepare(
        `SELECT risk_phase, mll_usd, start_balance_usd, press_at_usd, payout_taken_at,
                eod_balance_usd, eod_peak_usd, eod_sizes_session_start, eod_recorded_at
           FROM account_brokers WHERE account_id = ?`,
      )
      .get(accountId);
  }

  it("round-trips a declared phase and reads an untouched row as off", () => {
    setAccountBrokers([seed({ accountId: 8 }), seed({ accountId: 9 })]);
    expect(setAccountRiskPhase(8, COMBINE)).toBe(true);
    expect(getAccountRiskPhase(8)).toEqual({
      broker: "topstep",
      phase: "combine",
      mllUsd: COMBINE_MLL_USD,
      startBalanceUsd: 50_000,
      pressAtUsd: null,
      payoutTakenAt: null,
    });
    expect(getAccountRiskPhase(9)?.phase).toBe("off");
    expect(getAccountRiskPhase(777)).toBeNull();
  });

  it("stores off as NULL, so an opted-out row is the row nobody touched", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPhase(8, { phase: "off", mllUsd: null, startBalanceUsd: null, pressAtUsd: null });
    expect((phaseColumns(8) as { risk_phase: string | null }).risk_phase).toBeNull();
  });

  it("refuses a phase for an account the catalogue has never seen, and inserts nothing", () => {
    expect(setAccountRiskPhase(777, COMBINE)).toBe(false);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM account_brokers`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("stamps the payout on the first funded_paid save and never moves it", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPhase(8, { phase: "funded_paid", mllUsd: null, startBalanceUsd: null, pressAtUsd: null });
    const stamped = getAccountRiskPhase(8)?.payoutTakenAt;
    expect(stamped).toBeTruthy();

    setAccountRiskPhase(8, { phase: "funded_paid", mllUsd: null, startBalanceUsd: null, pressAtUsd: null });
    expect(getAccountRiskPhase(8)?.payoutTakenAt).toBe(stamped);
    // Not by a later phase change, and not by clearing the phase: a funded
    // account id is never a combine again, and the stamp is what holds it.
    setAccountRiskPhase(8, { phase: "off", mllUsd: null, startBalanceUsd: null, pressAtUsd: null });
    expect(getAccountRiskPhase(8)?.payoutTakenAt).toBe(stamped);
    setAccountRiskPhase(8, null);
    expect(getAccountRiskPhase(8)?.payoutTakenAt).toBe(stamped);
  });

  it("clears the phase, the MLL and the starting balance, and nothing else", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPhase(8, { phase: "funded_paid", mllUsd: 2_000, startBalanceUsd: 0, pressAtUsd: null });
    recordSessionClose(8, {
      balance: 50_000,
      sessionStart: TODAY,
      now: new Date("2026-09-08T21:05:00.000Z"),
    });

    expect(setAccountRiskPhase(8, null)).toBe(true);

    const row = phaseColumns(8) as Record<string, unknown>;
    expect(row.risk_phase).toBeNull();
    expect(row.mll_usd).toBeNull();
    expect(row.start_balance_usd).toBeNull();
    expect(row.press_at_usd).toBeNull();
    expect(row.payout_taken_at).not.toBeNull();
    expect(row.eod_balance_usd).toBe(50_000);
    expect(row.eod_peak_usd).toBe(50_000);
    expect(row.eod_sizes_session_start).toBe(TODAY);
    expect(row.eod_recorded_at).not.toBeNull();
  });

  it("survives the seed upsert every boot and page load re-runs", () => {
    // An `excluded.risk_phase` on UPSERT_SQL flips an opted-in account back to
    // `off` on a page load; an `excluded.eod_balance_usd` overwrites a
    // yesterday-stamped close with a mid-session balance. Both are silent.
    setAccountBrokers([seed({ accountId: 42 })]);
    setAccountRiskPhase(42, { phase: "funded_paid", mllUsd: 2_000, startBalanceUsd: 0, pressAtUsd: null });
    recordSessionClose(42, {
      balance: 7_500,
      sessionStart: TODAY,
      now: new Date("2026-09-08T21:05:00.000Z"),
    });
    const before = phaseColumns(42);

    setAccountBrokers([seed({ accountId: 42 })]);
    expect(phaseColumns(42)).toEqual(before);

    setAccountBroker(seed({ accountId: 42 }));
    expect(phaseColumns(42)).toEqual(before);
  });

  it("combine_press: the press threshold reads back and survives the seed upsert", () => {
    setAccountBrokers([seed({ accountId: 42 })]);
    setAccountRiskPhase(42, PRESS);
    expect(getAccountRiskPhase(42)).toMatchObject({ phase: "combine_press", pressAtUsd: 1_500 });
    const before = phaseColumns(42);
    expect(before).toMatchObject({ risk_phase: "combine_press", press_at_usd: 1_500 });

    setAccountBrokers([seed({ accountId: 42 })]);
    expect(phaseColumns(42)).toEqual(before);
    setAccountBroker(seed({ accountId: 42 }));
    expect(phaseColumns(42)).toEqual(before);
    expect(listAccountRiskPostures().find((r) => r.accountId === 42)?.riskPhase.pressAtUsd).toBe(1_500);
  });

  it("combine_press: a phase that does not read the threshold stores null for it", () => {
    setAccountBrokers([seed({ accountId: 42 })]);
    setAccountRiskPhase(42, PRESS);
    setAccountRiskPhase(42, COMBINE);
    expect(getAccountRiskPhase(42)?.pressAtUsd).toBeNull();
    expect((phaseColumns(42) as { press_at_usd: number | null }).press_at_usd).toBeNull();
  });

  it("is on the listing the Settings block renders", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPhase(8, COMBINE);
    recordSessionClose(8, {
      balance: 50_750,
      sessionStart: TODAY,
      now: new Date("2026-09-08T21:05:00.000Z"),
    });
    const listed = listAccountRiskPostures().find((r) => r.accountId === 8);
    expect(listed?.riskPhase).toEqual({
      broker: "topstep",
      phase: "combine",
      mllUsd: COMBINE_MLL_USD,
      startBalanceUsd: 50_000,
      pressAtUsd: null,
      payoutTakenAt: null,
    });
    expect(listed?.eodSample).toMatchObject({
      balanceUsd: 50_750,
      peakUsd: 50_750,
      sizesSessionStart: TODAY,
    });
  });
});

/** *Move to replacement* carries the operator's settings onto the new account
 *  so its legs can size, and never the two figures a reset changes. */
describe("carryRiskSettings", () => {
  const PRESS = { phase: "combine_press" as const, mllUsd: COMBINE_MLL_USD, startBalanceUsd: 50_000, pressAtUsd: 1_500 };

  beforeEach(() => {
    setAccountBrokers([
      seed({ accountId: 1, name: "50KTC-V2-100200-90020038", practice: false }),
      seed({ accountId: 2, name: "50KTC-V2-100200-90020099", practice: false }),
    ]);
  });

  it("copies risk per trade, max contracts, the daily limits and the phase onto an account with none", () => {
    setAccountRiskPosture(1, { maxRiskPerTradeUsd: 350, maxContracts: 3 });
    setAccountDailyPnlLimits(1, { dailyMaxLossUsd: 600, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: true });
    setAccountRiskPhase(1, PRESS);

    expect(carryRiskSettings(1, 2)).toEqual({ posture: true, dailyPnl: true, phase: "combine_press" });

    expect(getAccountRiskPosture(2)).toEqual({ maxRiskPerTradeUsd: 350, maxContracts: 3 });
    expect(getAccountDailyPnlLimits(2)).toEqual({
      dailyMaxLossUsd: 600,
      dailyMaxProfitUsd: 0,
      dailyPnlIncludeUnrealized: true,
    });
    // The maximum loss limit and starting balance are the new account's own —
    // a reset changes them — so they stay empty for the Risk prefill.
    expect(getAccountRiskPhase(2)).toMatchObject({
      phase: "combine_press",
      pressAtUsd: 1_500,
      mllUsd: null,
      startBalanceUsd: null,
    });
    // The old account keeps its own.
    expect(getAccountRiskPosture(1)).toEqual({ maxRiskPerTradeUsd: 350, maxContracts: 3 });
  });

  it("never overwrites what the new account already holds", () => {
    setAccountRiskPosture(1, { maxRiskPerTradeUsd: 350, maxContracts: 3 });
    setAccountDailyPnlLimits(1, { dailyMaxLossUsd: 600, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false });
    setAccountRiskPhase(1, PRESS);
    setAccountRiskPosture(2, { maxRiskPerTradeUsd: 100, maxContracts: 1 });
    setAccountDailyPnlLimits(2, { dailyMaxLossUsd: 0, dailyMaxProfitUsd: 900, dailyPnlIncludeUnrealized: false });
    setAccountRiskPhase(2, { phase: "funded_fresh", mllUsd: null, startBalanceUsd: null, pressAtUsd: null });

    expect(carryRiskSettings(1, 2)).toEqual({ posture: false, dailyPnl: false, phase: null });
    expect(getAccountRiskPosture(2)).toEqual({ maxRiskPerTradeUsd: 100, maxContracts: 1 });
    expect(getAccountDailyPnlLimits(2).dailyMaxProfitUsd).toBe(900);
    expect(getAccountDailyPnlLimits(2).dailyMaxLossUsd).toBe(0);
    expect(getAccountRiskPhase(2)?.phase).toBe("funded_fresh");
  });

  it("carries nothing from an account that holds nothing", () => {
    expect(carryRiskSettings(1, 2)).toEqual({ posture: false, dailyPnl: false, phase: null });
    expect(getAccountRiskPosture(2)).toBeNull();
    expect(getAccountRiskPhase(2)?.phase).toBe("off");
  });
});

describe("logAccountRiskChange", () => {
  beforeEach(() => {
    setAccountBrokers([seed({ accountId: 1, name: "50KTC-V2-100200-90020038", practice: false })]);
    setAccountRiskPosture(1, { maxRiskPerTradeUsd: 350, maxContracts: 3 });
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the field that changed, before and after, and nothing else", () => {
    const event = vi.spyOn(log, "event").mockImplementation(() => {});
    const before = getAccountRiskSettings(1);
    setAccountDailyPnlLimits(1, { dailyMaxLossUsd: 0, dailyMaxProfitUsd: 750, dailyPnlIncludeUnrealized: false });

    logAccountRiskChange(1, before, "saved in Settings");

    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(
      "account_risk_settings_changed",
      "db",
      "account 1 risk settings changed (saved in Settings): daily profit limit off → $750",
      { accountId: 1 },
    );
  });

  it("logs nothing for a save that changed nothing", () => {
    const event = vi.spyOn(log, "event").mockImplementation(() => {});
    const before = getAccountRiskSettings(1);
    setAccountRiskPosture(1, { maxRiskPerTradeUsd: 350, maxContracts: 3 });

    logAccountRiskChange(1, before, "saved in Settings");

    expect(event).not.toHaveBeenCalled();
  });

  it("describes a cleared posture and phase field by field", () => {
    setAccountRiskPhase(1, { phase: "funded_fresh", mllUsd: 2_000, startBalanceUsd: 0, pressAtUsd: null });
    const before = getAccountRiskSettings(1);
    setAccountRiskPosture(1, null);
    setAccountRiskPhase(1, null);

    expect(describeAccountRiskChange(before, getAccountRiskSettings(1))).toEqual([
      "risk per trade $350 → unset",
      "max contracts 3 → unset",
      "account phase funded_fresh → off",
      "maximum loss limit $2,000 → unset",
      "starting balance $0 → unset",
    ]);
  });
});

describe("recordSessionClose", () => {
  const SESSION_START = "2026-09-09T22:00:00.000Z";
  /** 17:05 ET, five minutes into the close gap: the session it sizes has not
   *  opened, so nothing that happens in it can be in this balance. */
  const IN_THE_GAP = new Date("2026-09-09T21:05:00.000Z");

  const closeAt = (balance: number, now: Date = IN_THE_GAP) =>
    recordSessionClose(1, { balance, sessionStart: SESSION_START, now });

  const sampleOf = (accountId: number) =>
    db
      .prepare(
        `SELECT eod_balance_usd AS balance, eod_peak_usd AS peak,
                eod_sizes_session_start AS stamp
           FROM account_brokers WHERE account_id = ?`,
      )
      .get(accountId) as { balance: number | null; peak: number | null; stamp: string | null };

  beforeEach(() => {
    setAccountBrokers([seed({ accountId: 1 })]);
  });

  it("writes the close, the stamp and the first peak", () => {
    expect(closeAt(50_000)).toBe(true);
    expect(sampleOf(1)).toEqual({ balance: 50_000, peak: 50_000, stamp: SESSION_START });
  });

  it("never lets the peak decrease", () => {
    closeAt(50_000);
    closeAt(51_000);
    closeAt(50_200);
    expect(sampleOf(1)).toEqual({ balance: 50_200, peak: 51_000, stamp: SESSION_START });
  });

  it("writes nothing once the session it would size has opened", () => {
    // A fill in that session could already be in the balance, and a budget set
    // from a live balance is the intraday posture nobody measured.
    closeAt(50_000);
    expect(closeAt(48_000, new Date("2026-09-09T22:30:00.000Z"))).toBe(false);
    expect(sampleOf(1)).toEqual({ balance: 50_000, peak: 50_000, stamp: SESSION_START });
  });

  it("writes nothing for a non-finite balance", () => {
    // The catalogue's `balance` is safe to default to 0 elsewhere; that
    // default is withdrawn here, because a zero close reads as busted.
    closeAt(50_000);
    expect(closeAt(Number.NaN)).toBe(false);
    expect(closeAt(Number.POSITIVE_INFINITY)).toBe(false);
    expect(sampleOf(1)).toEqual({ balance: 50_000, peak: 50_000, stamp: SESSION_START });
  });

  it("writes nothing for an account the catalogue has never seen", () => {
    expect(
      recordSessionClose(777, { balance: 50_000, sessionStart: SESSION_START, now: IN_THE_GAP }),
    ).toBe(false);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM account_brokers`).get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("resolveSessionPosture", () => {
  const NOW = new Date("2026-09-09T14:00:00.000Z");
  const TODAY = currentCmeSessionStart(NOW);
  /** In the gap before `TODAY` opened — when the sampler runs. */
  const AT_THE_CLOSE = new Date("2026-09-08T21:05:00.000Z");

  it("answers exactly the flat posture on an account that is off", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPosture(8, { maxRiskPerTradeUsd: 225, maxContracts: 3 });
    expect(resolveSessionPosture(8, NOW)).toEqual({
      posture: getAccountRiskPosture(8),
      phase: "off",
      basis: "flat",
      headroomUsd: null,
      floorUsd: null,
      closeUsd: null,
      peakUsd: null,
      sizesSessionStart: null,
    });
  });

  it("answers a null posture for an account with no row at all", () => {
    expect(resolveSessionPosture(777, NOW).posture).toBeNull();
  });

  it("sizes a combine from the close the sampler recorded", () => {
    setAccountBrokers([seed({ accountId: 8, name: "50KTC-55555", practice: false })]);
    setAccountRiskPosture(8, { maxRiskPerTradeUsd: 500, maxContracts: 3 });
    setAccountRiskPhase(8, {
      phase: "combine",
      mllUsd: COMBINE_MLL_USD,
      startBalanceUsd: 50_000,
      pressAtUsd: null,
    });
    recordSessionClose(8, { balance: 51_000, sessionStart: TODAY, now: AT_THE_CLOSE });

    expect(resolveSessionPosture(8, NOW)).toMatchObject({
      posture: { maxRiskPerTradeUsd: 500, maxContracts: 3 },
      phase: "combine",
      basis: "bucket_500",
      floorUsd: 49_000,
      headroomUsd: 2_000,
    });
  });

  it("sizes a combine_press from its stored press threshold", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPosture(8, { maxRiskPerTradeUsd: 500, maxContracts: 3 });
    setAccountRiskPhase(8, {
      phase: "combine_press",
      mllUsd: COMBINE_MLL_USD,
      startBalanceUsd: 50_000,
      pressAtUsd: 2_500,
    });
    // Headroom $2,000: the combine's top bucket, but under this row's threshold.
    recordSessionClose(8, { balance: 51_000, sessionStart: TODAY, now: AT_THE_CLOSE });

    expect(resolveSessionPosture(8, NOW)).toMatchObject({
      posture: { maxRiskPerTradeUsd: 350 },
      phase: "combine_press",
      basis: "bucket_350",
      headroomUsd: 2_000,
    });
  });

  it("takes the lowest budget of the phase when the sample sizes an older session", () => {
    setAccountBrokers([seed({ accountId: 8 })]);
    setAccountRiskPosture(8, { maxRiskPerTradeUsd: 500, maxContracts: 3 });
    setAccountRiskPhase(8, {
      phase: "combine",
      mllUsd: COMBINE_MLL_USD,
      startBalanceUsd: 50_000,
      pressAtUsd: null,
    });
    const yesterday = currentCmeSessionStart(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
    recordSessionClose(8, {
      balance: 51_000,
      sessionStart: yesterday,
      now: new Date("2026-09-07T21:05:00.000Z"),
    });

    expect(resolveSessionPosture(8, NOW)).toMatchObject({
      posture: { maxRiskPerTradeUsd: 225, maxContracts: 3 },
      basis: "stale_floor",
    });
  });
});

// The seam three fan-out sites share. It was three verbatim inline copies
// before, held together by an invariant in a doc and nothing else.
describe("toAccountBrokerSeeds", () => {
  const account = (over: Partial<Account> = {}): Account => ({
    id: 1,
    name: "PRAC-V2-100200-90012114",
    balance: 0,
    canTrade: true,
    isVisible: true,
    broker: "topstep",
    practice: true,
    ...over,
  });

  it("carries every field the classifier reads", () => {
    expect(toAccountBrokerSeeds([account()])).toEqual([
      {
        accountId: 1,
        broker: BrokerKind.Topstep,
        name: "PRAC-V2-100200-90012114",
        practice: true,
      },
    ]);
  });

  it("maps a Tradovate account onto the Tradovate kind", () => {
    const [row] = toAccountBrokerSeeds([
      account({ id: 2, broker: "tradovate", name: "DEMO12345", practice: false }),
    ]);
    expect(row).toEqual({
      accountId: 2,
      broker: BrokerKind.Tradovate,
      name: "DEMO12345",
      practice: false,
    });
  });

  it("round-trips through the table into a classifiable identity", () => {
    setAccountBrokers(toAccountBrokerSeeds([account({ id: 42 })]));
    expect(getAccountTradingIdentity(42)).toEqual({
      name: "PRAC-V2-100200-90012114",
      broker: "topstep",
      practice: true,
    });
    expect(autoTradeVerdictForAccountId(42)).toEqual({ permitted: true });
  });

  it("returns an empty list for an empty fan-out", () => {
    expect(toAccountBrokerSeeds([])).toEqual([]);
  });
});

/** A website-sourced account, as Topstep's record for a live 50K combine reads
 *  (temp/tradingaccount.json, 2026-10-14). */
const COMBINE_FACTS: BrokerAccountFacts = {
  autoOcoBrackets: true,
  bracketAutoApply: null,
  bracketAmountToRiskUsd: null,
  bracketAmountToMakeUsd: null,
  startingBalanceUsd: 50_000,
  maximumLossUsd: 48_000,
  highestBalanceUsd: 50_000,
  startOfDayBalanceUsd: 48_722.9,
  dailyLossUsd: 1_000,
  personalDailyLossLimitUsd: null,
  personalDailyProfitTargetUsd: null,
  stage: 1,
  templateId: 67,
};

function websiteAccount(over: Partial<AccountStateAnswer> & { accountId: number }): AccountStateAnswer {
  return {
    source: "website",
    state: "ok",
    cause: null,
    statusCode: 0,
    lockoutReason: null,
    lockoutUntil: null,
    facts: COMBINE_FACTS,
    ...over,
  };
}

describe("recordAccountStates", () => {
  const CHECKED_AT = "2026-10-14T21:00:00.000Z";
  const statusOf = (id: number) => {
    const s = listAccountRiskPostures().find((r) => r.accountId === id)?.status;
    return s && { state: s.state, checkedAt: s.checkedAt };
  };
  const recordListed = (ids: number[], at: string, cannotTrade: number[] = []) =>
    newlyDeadOf(recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch(ids, cannotTrade), at));

  beforeEach(() => {
    setAccountBrokers([
      seed({ accountId: 1, name: "PRAC-V2-100200-90012114", practice: true }),
      seed({ accountId: 2, name: "50KTC-V2-100200-90020038", practice: false }),
      seed({ accountId: 3, broker: BrokerKind.Tradovate, name: "DEMO1", practice: true }),
    ]);
  });

  it("adds every status column nullable with no default, so a row nobody checked reads as never checked", () => {
    const cols = db.prepare(`PRAGMA table_info(account_brokers)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const status = cols.filter((c) => c.name.startsWith("broker_"));
    // The status, its stamp, its eighteen companions, and the balance pair.
    expect(status.length).toBe(22);
    for (const col of status) expect(col).toMatchObject({ notnull: 0, dflt_value: null });
    expect(listAccountRiskPostures()[0]?.status).toEqual({
      state: null,
      checkedAt: null,
      source: null,
      statusCode: null,
      lockoutReason: null,
      lockoutUntil: null,
    });
    expect(getBrokerAccountFacts(1)).toBeNull();
  });

  it("moves the first cut's active / inactive rows to ok / dead", () => {
    db.prepare(`UPDATE account_brokers SET broker_status = 'active' WHERE account_id = 1`).run();
    db.prepare(`UPDATE account_brokers SET broker_status = 'inactive' WHERE account_id = 2`).run();
    for (const fn of migrations) fn(db);
    expect(statusOf(1)?.state).toBe("ok");
    expect(statusOf(2)?.state).toBe("dead");
  });

  it("marks what the broker listed ok and the rest of that broker's accounts dead", () => {
    expect(recordListed([1], CHECKED_AT)).toEqual([2]);
    expect(statusOf(1)).toEqual({ state: "ok", checkedAt: CHECKED_AT });
    expect(statusOf(2)).toEqual({ state: "dead", checkedAt: CHECKED_AT });
    // The other broker said nothing on this call, so its account is untouched.
    expect(statusOf(3)).toEqual({ state: null, checkedAt: null });
  });

  // `canTrade: false` covers a violation and a lockout alike; locked keeps the
  // account listed on Risk, and a later phase refuses locked anyway.
  it("reads a listed account the search says cannot trade as locked, with no reason and no end", () => {
    expect(recordListed([1, 2], CHECKED_AT, [2])).toEqual([]);
    expect(statusOf(1)?.state).toBe("ok");
    expect(listAccountRiskPostures().find((r) => r.accountId === 2)?.status).toEqual({
      state: "locked",
      checkedAt: CHECKED_AT,
      source: "search",
      statusCode: null,
      lockoutReason: null,
      lockoutUntil: null,
    });
  });

  it("stores a null fact field as NULL — unknown — beside the ones the website reported", () => {
    recordAccountStates(
      BrokerKind.Topstep,
      {
        source: "website",
        accounts: [
          websiteAccount({
            accountId: 1,
            facts: { ...COMBINE_FACTS, autoOcoBrackets: null, dailyLossUsd: null, maximumLossUsd: null },
          }),
        ],
      },
      CHECKED_AT,
    );
    const raw = db
      .prepare(
        `SELECT broker_auto_oco, broker_daily_loss_limit_usd, broker_max_loss_floor_usd, broker_starting_balance_usd
           FROM account_brokers WHERE account_id = 1`,
      )
      .get();
    expect(raw).toEqual({
      broker_auto_oco: null,
      broker_daily_loss_limit_usd: null,
      broker_max_loss_floor_usd: null,
      broker_starting_balance_usd: 50_000,
    });
    expect(getBrokerAccountFacts(1)).toEqual({
      ...COMBINE_FACTS,
      autoOcoBrackets: null,
      dailyLossUsd: null,
      maximumLossUsd: null,
    });
  });

  // A website answer that omitted an account the search listed carries the
  // search's reading for it; that row is search-sourced, so its facts are unknown.
  it("writes each account's own source, and no facts for a search-sourced one", () => {
    recordAccountStates(
      BrokerKind.Topstep,
      {
        source: "website",
        accounts: [
          websiteAccount({ accountId: 1 }),
          { ...accountStatesFromSearch([2], []).accounts[0]! },
        ],
      },
      CHECKED_AT,
    );
    expect(listAccountRiskPostures().find((r) => r.accountId === 2)?.status).toMatchObject({
      state: "ok",
      source: "search",
    });
    expect(getBrokerAccountFacts(2)).toBeNull();
    expect(getBrokerAccountFacts(1)).toEqual(COMBINE_FACTS);
    // The Risk list carries the same facts for its prefill, and none off a search.
    const risk = listAccountRiskPostures();
    expect(risk.find((r) => r.accountId === 1)?.brokerFacts).toEqual(COMBINE_FACTS);
    expect(risk.find((r) => r.accountId === 2)?.brokerFacts).toBeNull();
  });

  it("reports an account as newly dead once, not on every check that confirms it", () => {
    recordListed([1], CHECKED_AT);
    expect(recordListed([1], "2026-10-14T21:01:00.000Z")).toEqual([]);
  });

  it("takes an empty answer from a broker that answered as every account closed", () => {
    expect(recordListed([], CHECKED_AT)).toEqual([1, 2]);
    expect(statusOf(1)?.state).toBe("dead");
  });

  it("brings an account back when its broker lists it again", () => {
    recordListed([1], CHECKED_AT);
    recordListed([1, 2], "2026-10-15T21:00:00.000Z");
    expect(statusOf(2)).toEqual({ state: "ok", checkedAt: "2026-10-15T21:00:00.000Z" });
  });

  it("stores the cause with the state for the gate, keeps it through a fallback, and drops it on ok", () => {
    const until = "2026-10-15T22:00:00.000Z";
    const lock = websiteAccount({ accountId: 2, state: "locked", cause: "daily-loss", lockoutUntil: until });
    const changes = recordAccountStates(BrokerKind.Topstep, { source: "website", accounts: [lock] }, CHECKED_AT);
    expect(changes).toEqual([
      // Account 1 is absent from the answer, so it is dead.
      { accountId: 1, from: { state: null, cause: null }, to: { state: "dead", cause: null, reason: null, until: null } },
      { accountId: 2, from: { state: null, cause: null }, to: { state: "locked", cause: "daily-loss", reason: null, until } },
    ]);
    expect(getAccountDeployState(2)?.cause).toBe("daily-loss");

    // The search's ok would unlock it early; the row, cause included, stays.
    expect(recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([2], []), "2026-10-15T21:00:00.000Z")).toEqual([]);
    expect(getAccountDeployState(2)?.cause).toBe("daily-loss");

    const unlocked = recordAccountStates(BrokerKind.Topstep, { source: "website", accounts: [websiteAccount({ accountId: 2, cause: "website" })] }, "2026-10-15T22:01:00.000Z");
    expect(unlocked.find((t) => t.accountId === 2)?.to).toEqual({ state: "ok", cause: null, reason: null, until: null });
    expect(getAccountDeployState(2)?.cause).toBeNull();
  });

  it("stores a website answer's lock and facts with its status", () => {
    const until = "2026-10-15T22:00:00.000Z";
    const answer = {
      source: "website" as const,
      accounts: [
        websiteAccount({ accountId: 1, state: "locked", lockoutReason: "Daily loss limit", lockoutUntil: until }),
        websiteAccount({ accountId: 2, state: "dead", statusCode: 6 }),
      ],
    };
    expect(newlyDeadOf(recordAccountStates(BrokerKind.Topstep, answer, CHECKED_AT))).toEqual([2]);
    const status = listAccountRiskPostures().find((r) => r.accountId === 1)?.status;
    expect(status).toEqual({
      state: "locked",
      checkedAt: CHECKED_AT,
      source: "website",
      statusCode: 0,
      lockoutReason: "Daily loss limit",
      lockoutUntil: until,
    });
    expect(listAccountRiskPostures().find((r) => r.accountId === 2)?.status.statusCode).toBe(6);
    expect(getBrokerAccountFacts(1)).toEqual(COMBINE_FACTS);
  });

  it("keeps an OCO setting the website reported off as false, apart from unknown", () => {
    recordAccountStates(
      BrokerKind.Topstep,
      {
        source: "website",
        accounts: [
          websiteAccount({
            accountId: 1,
            facts: { ...COMBINE_FACTS, autoOcoBrackets: false, bracketAutoApply: true },
          }),
        ],
      },
      CHECKED_AT,
    );
    expect(getBrokerAccountFacts(1)).toMatchObject({ autoOcoBrackets: false, bracketAutoApply: true });
  });

  // A website read that failed must leave an "on" unknown rather than keep it
  // stale — the deploy gate refuses an unknown OCO — and never read as "OCO off".
  it("stores the website-only fields as unknown on a search answer, never as false", () => {
    recordAccountStates(
      BrokerKind.Topstep,
      { source: "website", accounts: [websiteAccount({ accountId: 1 })] },
      CHECKED_AT,
    );
    recordListed([1], "2026-10-15T21:00:00.000Z");
    expect(getBrokerAccountFacts(1)).toBeNull();
    const raw = db
      .prepare(`SELECT broker_auto_oco, broker_status_code, broker_status_source FROM account_brokers WHERE account_id = 1`)
      .get();
    expect(raw).toEqual({ broker_auto_oco: null, broker_status_code: null, broker_status_source: "search" });
  });

  // Ineligible accounts still list `canTrade: true` on the search, so a fallback
  // that took the search's word would revive a website `dead` — and the engine's
  // entry gate would resume entries on it.
  it("keeps a website dead through a search fallback, refreshing only the stamp", () => {
    const deadAnswer = {
      source: "website" as const,
      accounts: [websiteAccount({ accountId: 1 }), websiteAccount({ accountId: 2, state: "dead", statusCode: 6 })],
    };
    expect(newlyDeadOf(recordAccountStates(BrokerKind.Topstep, deadAnswer, CHECKED_AT))).toEqual([2]);
    const later = "2026-10-15T21:00:00.000Z";
    expect(recordListed([1, 2], later)).toEqual([]);
    expect(listAccountRiskPostures().find((r) => r.accountId === 2)?.status).toEqual({
      state: "dead",
      checkedAt: later,
      source: "website",
      statusCode: 6,
      lockoutReason: null,
      lockoutUntil: null,
    });
    expect(getBrokerAccountFacts(2)).toEqual(COMBINE_FACTS);
    expect(accountEntrySkip(getAccountDeployState(2), new Date(later))?.kind).toBe("dead");
    // The live one still takes the fallback's reading.
    expect(statusOf(1)).toEqual({ state: "ok", checkedAt: later });
  });

  it("still revives a dead the search itself gave, when the search lists it again", () => {
    recordListed([1], CHECKED_AT);
    recordListed([1, 2], "2026-10-15T21:00:00.000Z");
    expect(statusOf(2)?.state).toBe("ok");
  });

  // An off OCO stops a running deployment's entries; a fallback that nulled it
  // would read unknown, which the engine lets trade.
  it("keeps an OCO the website read off through a search fallback, so entries stay skipped", () => {
    recordAccountStates(
      BrokerKind.Topstep,
      {
        source: "website",
        accounts: [websiteAccount({ accountId: 1, facts: { ...COMBINE_FACTS, autoOcoBrackets: false } })],
      },
      CHECKED_AT,
    );
    const later = "2026-10-15T21:00:00.000Z";
    expect(accountEntrySkip(getAccountDeployState(1), new Date(later))?.kind).toBe("oco-off");
    recordListed([1], later);
    expect(getAccountDeployState(1)?.autoOcoBrackets).toBe(false);
    expect(accountEntrySkip(getAccountDeployState(1), new Date(later))?.kind).toBe("oco-off");
    // Every other fact is unknown off a fallback, as before.
    expect(getBrokerAccountFacts(1)).toBeNull();
    // A website read that says on again clears it.
    recordAccountStates(
      BrokerKind.Topstep,
      { source: "website", accounts: [websiteAccount({ accountId: 1 })] },
      "2026-10-16T21:00:00.000Z",
    );
    expect(accountEntrySkip(getAccountDeployState(1), new Date("2026-10-16T21:00:00.000Z"))).toBeNull();
  });

  // The seed hears only what a broker listed and cannot say what went missing,
  // so it must not be able to undo a check's "dead" — a blown account
  // re-seeded by any fan-out would otherwise reappear on the Risk page.
  it("is not reset by the seed upsert, through either writer", () => {
    recordAccountStates(
      BrokerKind.Topstep,
      { source: "website", accounts: [websiteAccount({ accountId: 1 })] },
      CHECKED_AT,
    );
    setAccountBrokers([
      seed({ accountId: 1, name: "PRAC-V2-100200-90012114", practice: true }),
      seed({ accountId: 2, name: "50KTC-V2-100200-90020038", practice: false }),
    ]);
    setAccountBroker(seed({ accountId: 2, name: "50KTC-V2-100200-90020038", practice: false }));
    expect(statusOf(2)).toEqual({ state: "dead", checkedAt: CHECKED_AT });
    expect(getBrokerAccountFacts(1)).toEqual(COMBINE_FACTS);
  });

  it("deletes nothing: the dead account's row, posture and trades all stay", () => {
    setAccountRiskPosture(2, { maxRiskPerTradeUsd: 350, maxContracts: 3 });
    const tradeId = insertPendingEntry({
      deploymentId: "depl-2",
      strategyKey: "orb-confluence-capped",
      accountId: 2,
      ticker: "/MNQ",
      contractId: "CON.F.US.MNQ.Z26",
      side: 0,
      size: 1,
      entryOrderId: null,
      entrySubmittedAt: "2026-10-14T14:00:00.000Z",
    });

    recordListed([1], CHECKED_AT);

    expect(getTradeById(tradeId)?.accountId).toBe(2);
    expect(getAccountTradingIdentity(2)?.name).toBe("50KTC-V2-100200-90020038");
    expect(getAccountRiskPosture(2)).toEqual({ maxRiskPerTradeUsd: 350, maxContracts: 3 });
  });

  it("does not create a row for an id the catalogue has never seen, nor touch another broker's", () => {
    recordListed([1, 99, 3], CHECKED_AT);
    expect(getAccountBrokerOrNull(99)).toBeNull();
    expect(statusOf(3)).toEqual({ state: null, checkedAt: null });
  });

  // A check whose answer arrived before a newer one must not record the
  // account dead over it, nor report it as newly gone.
  it("leaves a row a newer answer already stamped, and does not report it", () => {
    const EARLIER = "2026-10-14T20:59:00.000Z";
    db.prepare(
      `UPDATE account_brokers SET broker_status = 'ok', broker_status_checked_at = ? WHERE account_id = 2`,
    ).run(CHECKED_AT);

    expect(recordListed([1], EARLIER)).toEqual([]);

    expect(statusOf(2)).toEqual({ state: "ok", checkedAt: CHECKED_AT });
    expect(statusOf(1)).toEqual({ state: "ok", checkedAt: EARLIER });
  });

  // The guard covers every column the writer sets, not just the status: an
  // older fallback must not wipe a newer website answer's facts and lock.
  it("leaves a newer website answer's lock and facts alone under an older answer", () => {
    const LATER = "2026-10-14T21:30:00.000Z";
    recordAccountStates(
      BrokerKind.Topstep,
      {
        source: "website",
        accounts: [
          websiteAccount({ accountId: 1, state: "locked", lockoutReason: "Daily loss limit" }),
          websiteAccount({ accountId: 2 }),
        ],
      },
      LATER,
    );

    expect(recordListed([], CHECKED_AT)).toEqual([]);

    expect(listAccountRiskPostures().find((r) => r.accountId === 1)?.status).toMatchObject({
      state: "locked",
      checkedAt: LATER,
      source: "website",
      lockoutReason: "Daily loss limit",
    });
    expect(getBrokerAccountFacts(2)).toEqual(COMBINE_FACTS);
  });
});

describe("markAccountsActive", () => {
  const CHECKED_AT = "2026-10-14T21:00:00.000Z";
  const LATER = "2026-10-14T21:30:00.000Z";
  const statusOf = (id: number) => {
    const s = listAccountRiskPostures().find((r) => r.accountId === id)?.status;
    return s && { state: s.state, checkedAt: s.checkedAt };
  };
  const recordListed = (ids: number[], at: string) =>
    newlyDeadOf(recordAccountStates(BrokerKind.Tradovate, accountStatesFromSearch(ids, []), at));

  beforeEach(() => {
    setAccountBrokers([
      seed({ accountId: 1, broker: BrokerKind.Tradovate, name: "DEMO1", practice: true }),
      seed({ accountId: 2, broker: BrokerKind.Tradovate, name: "DEMO2", practice: true }),
      seed({ accountId: 3, name: "PRAC-V2-100200-90012114", practice: true }),
    ]);
  });

  // Tradovate's search lists only accounts that can trade, so a listed id is
  // an ok answer: a false "dead" heals on the next refresh, not the next day.
  it("marks a listed account ok again, and stamps it", () => {
    recordListed([1], CHECKED_AT);
    expect(statusOf(2)?.state).toBe("dead");

    markAccountsActive([2], LATER);

    expect(statusOf(2)).toEqual({ state: "ok", checkedAt: LATER });
  });

  it("never marks anything dead — an unlisted account keeps what it had", () => {
    recordListed([1], CHECKED_AT);

    markAccountsActive([1], LATER);

    expect(statusOf(2)).toEqual({ state: "dead", checkedAt: CHECKED_AT });
    expect(statusOf(3)).toEqual({ state: null, checkedAt: null });
  });

  it("does not create a row for an id the catalogue has never seen", () => {
    markAccountsActive([99], LATER);
    expect(getAccountBrokerOrNull(99)).toBeNull();
  });

  // Topstep's active-only search lists dead accounts; a Topstep id reaching
  // this writer by any caller must not revive one.
  it("leaves a Topstep account alone even when handed its id", () => {
    recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([], []), CHECKED_AT);
    expect(statusOf(3)?.state).toBe("dead");

    markAccountsActive([3], LATER);

    expect(statusOf(3)).toEqual({ state: "dead", checkedAt: CHECKED_AT });
  });

  // The race: a refresh lists the account, stalls on its other arm, and a
  // status check records the account dead meanwhile. The stalled refresh's
  // answer is the older one and must not revive the account.
  it("does not overwrite a newer answer with an older one", () => {
    recordListed([1], LATER);

    markAccountsActive([2], CHECKED_AT);

    expect(statusOf(2)).toEqual({ state: "dead", checkedAt: LATER });
  });
});

describe("recordAccountBalances", () => {
  const EARLIER = "2026-10-21T21:55:00.000Z";
  const LATER = "2026-10-21T21:55:30.000Z";
  const balanceOf = (id: number) => {
    const r = listAccountBalances().find((b) => b.accountId === id);
    return r && { balanceUsd: r.balanceUsd, balanceAt: r.balanceAt };
  };

  beforeEach(() => {
    setAccountBrokers([
      seed({ accountId: 1 }),
      seed({ accountId: 2, name: "50KTC-V2-100200-90020038", practice: false }),
      seed({ accountId: 3, broker: BrokerKind.Tradovate, name: "DEMO1", practice: true }),
    ]);
  });

  it("stores each balance with the time its search answered, and reads NULL as unknown", () => {
    recordAccountBalances(BrokerKind.Topstep, new Map([[1, 50_123.5]]), EARLIER);
    expect(balanceOf(1)).toEqual({ balanceUsd: 50_123.5, balanceAt: EARLIER });
    expect(balanceOf(2)).toEqual({ balanceUsd: null, balanceAt: null });
  });

  // Two checks can overlap: a slow one's older answer must not land over a
  // faster, newer one.
  it("refuses an answer older than the one stored", () => {
    recordAccountBalances(BrokerKind.Topstep, new Map([[1, 49_000]]), LATER);
    recordAccountBalances(BrokerKind.Topstep, new Map([[1, 50_000]]), EARLIER);
    expect(balanceOf(1)).toEqual({ balanceUsd: 49_000, balanceAt: LATER });
  });

  it("leaves an account the answer does not mention as it was — missing is not zero", () => {
    recordAccountBalances(BrokerKind.Topstep, new Map([[1, 50_000], [2, 48_000]]), EARLIER);
    recordAccountBalances(BrokerKind.Topstep, new Map([[1, 50_500]]), LATER);
    expect(balanceOf(2)).toEqual({ balanceUsd: 48_000, balanceAt: EARLIER });
  });

  it("skips a non-finite balance, another broker's account, and an uncatalogued id", () => {
    recordAccountBalances(
      BrokerKind.Topstep,
      new Map([
        [1, Number.NaN],
        [3, 10_000],
        [99, 5_000],
      ]),
      EARLIER,
    );
    expect(balanceOf(1)).toEqual({ balanceUsd: null, balanceAt: null });
    expect(balanceOf(3)).toEqual({ balanceUsd: null, balanceAt: null });
    expect(balanceOf(99)).toBeUndefined();
  });

  it("reads the stored broker as it is, and one neither broker writes as unknown", () => {
    insertLegacyRow(4, "ibkr");
    expect(listAccountBalances().map((b) => [b.accountId, b.broker])).toEqual([
      [1, "topstep"],
      [2, "topstep"],
      [3, "tradovate"],
      [4, "unknown"],
    ]);
  });

  it("is not touched by a re-seed", () => {
    recordAccountBalances(BrokerKind.Topstep, new Map([[1, 50_000]]), EARLIER);
    setAccountBrokers([seed({ accountId: 1 })]);
    expect(balanceOf(1)).toEqual({ balanceUsd: 50_000, balanceAt: EARLIER });
  });
});
