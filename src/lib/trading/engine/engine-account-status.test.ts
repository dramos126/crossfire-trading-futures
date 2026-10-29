/**
 * The account status check: what one broker fan-out writes onto
 * `account_brokers`, what a failed one leaves alone, and the daily clock that
 * runs it.
 *
 * Real in-memory better-sqlite3 with the shipped migration replayed, as in
 * `account-brokers.test.ts`: the property under test is "a failed check
 * changes nothing stored", and a mocked writer would only prove it was not
 * called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
// The registry below is built on fake clients with Tradovate configured, so
// it never reads deployments; the real module drags in the strategy catalogue,
// which needs webpack's `require.context`.
vi.mock("@/lib/db/deployments", () => ({ listManagedDeployments: vi.fn(() => []) }));
vi.mock("@/lib/brokers/topstep/client", () => ({ TopstepClient: vi.fn() }));
vi.mock("@/lib/brokers/tradovate/client", () => ({ TradovateClient: vi.fn() }));

import {
  BrokerKind,
  accountStatesFromSearch,
  getBrokerAccountFacts,
  listAccountBalances,
  listAccountRiskPostures,
  recordAccountStates,
  setAccountBrokers,
  setAccountRiskPosture,
  getAccountDeployState,
  type AccountStateAnswer,
  type BrokerAccountFacts,
} from "@/lib/db/account-brokers";
import {
  ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS,
  ACCOUNT_STATUS_CHECK_PERIOD_MS,
  ACCOUNT_STATUS_JOB_INTERVAL_MS,
  ACCOUNT_STATUS_REJECTION_SPACING_MS,
  AccountStatusJob,
  CANNOT_TRADE_LOCK_REASON,
  accountStatusFanOutOf,
  dailyLossLockReason,
  maxLossReason,
  profitTargetLockReason,
  registryStatusFanOut,
  withTopstepSearchLocks,
  type AccountStatusFanOut,
  type AccountStatusJobDeps,
  type RegistryStatusFanOutDeps,
} from "./engine-account-status";
import { BrokerRegistry, type RefreshResult } from "../broker-access/broker-registry";
import type { TopstepClient } from "@/lib/brokers/topstep/client";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import type { AccountClass } from "@/lib/brokers/topstep/account-classification";
import {
  topstepStatusAnswer,
  type TopstepTradingAccount,
  type TopstepTradingAccountsAnswer,
} from "@/lib/brokers/topstep/trading-account";
import type { Account } from "@/lib/brokers/types";
import { listedOnRisk } from "@/components/account/account-risk-view";

/** 2026-10-14 17:00 ET — inside the CME break, a Wednesday. */
const T0 = new Date("2026-10-14T21:00:00.000Z");

/** Every answer stamped at the pinned instant unless a test says otherwise. */
function fanOut(
  answered: Array<[BrokerKind, number[]]>,
  failed: BrokerKind[] = [],
): AccountStatusFanOut {
  return {
    answered: new Map(
      answered.map(
        ([kind, ids]) =>
          [kind, { answer: accountStatesFromSearch(ids, []), at: new Date().toISOString() }] as const,
      ),
    ),
    failed,
    fallbacks: [],
  };
}

/** One record of Topstep's website answer, shaped as the 50K combine in
 *  temp/tradingaccount.json (2026-10-14). */
function websiteRecord(over: Partial<TopstepTradingAccount> & { accountId: number }): TopstepTradingAccount {
  return {
    accountName: `50KTC-SKU-V2-DLL-100200-${over.accountId}`,
    ineligible: false,
    status: 0,
    lockoutReason: null,
    lockoutExpiration: null,
    autoOcoBrackets: true,
    bracketAutoApply: null,
    bracketAmountToRisk: null,
    bracketAmountToMake: null,
    startingBalance: 50_000,
    maximumLoss: 48_000,
    highestBalance: 50_000,
    startOfDayBalance: 48_722.9,
    dailyLoss: 1_000,
    personalDailyLossLimit: null,
    personalDailyProfitTarget: null,
    stage: 1,
    templateId: 67,
    ...over,
  };
}

const WEBSITE_DOWN: TopstepTradingAccountsAnswer = { ok: false, kind: "http", reason: "HTTP 503" };

function makeJob(answers: Array<AccountStatusFanOut | Error>) {
  const events: Array<{ event: string; message: string; subject?: { accountId: number } }> = [];
  let call = 0;
  const fan = vi.fn(async () => {
    const next = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const deps = {
    fanOut: fan,
    logEvent: (event: string, message: string, subject?: { accountId: number }) =>
      events.push(subject === undefined ? { event, message } : { event, message, subject }),
  } satisfies AccountStatusJobDeps;
  return { job: new AccountStatusJob(deps), fan, events };
}

/** The status and its stamp as stored, keyed by account. */
function stored() {
  return Object.fromEntries(
    listAccountRiskPostures().map((r) => [r.accountId, { state: r.status.state, checkedAt: r.status.checkedAt }]),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  setAccountBrokers([
    { accountId: 1, broker: BrokerKind.Topstep, name: "PRAC-V2-100200-90012114", practice: true },
    { accountId: 2, broker: BrokerKind.Topstep, name: "50KTC-V2-100200-90020038", practice: false },
    { accountId: 3, broker: BrokerKind.Tradovate, name: "DEMO1", practice: true },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A refresh result as the registry builds it: `listed` is non-null exactly
 *  for an arm that answered, `errors` exactly for an arm that failed. */
function refreshResult(
  listed: RefreshResult["listed"],
  errors: Partial<RefreshResult["errors"]> = {},
  cannotTrade: Partial<RefreshResult["cannotTrade"]> = {},
): RefreshResult {
  const full = { topstep: null, tradovate: null, ...errors };
  const at = (ids: readonly number[] | null) => (ids === null ? null : T0.toISOString());
  const none = (ids: readonly number[] | null) => (ids === null ? null : []);
  return {
    partial: full.topstep !== null || full.tradovate !== null,
    errors: full,
    listed,
    cannotTrade: { topstep: none(listed.topstep), tradovate: none(listed.tradovate), ...cannotTrade },
    answeredAt: { topstep: at(listed.topstep), tradovate: at(listed.tradovate) },
    balances: { topstep: listed.topstep === null ? null : new Map(), tradovate: null },
    size: 0,
    removed: [],
    kindChanges: [],
  };
}

describe("accountStatusFanOutOf", () => {
  it("reads an arm that answered as its broker's list, stamped when it answered", () => {
    const result = refreshResult({ topstep: [1, 2], tradovate: [3] }, {}, { topstep: [2] });
    result.answeredAt.tradovate = "2026-10-14T21:00:05.000Z";
    const out = accountStatusFanOutOf(result);
    expect([...out.answered]).toEqual([
      [BrokerKind.Topstep, { ids: [1, 2], cannotTrade: [2], at: T0.toISOString(), balances: new Map() }],
      [BrokerKind.Tradovate, { ids: [3], cannotTrade: [], at: "2026-10-14T21:00:05.000Z", balances: null }],
    ]);
    expect(out.failed).toEqual([]);
  });

  it("reads an arm that threw as failed, never as an empty answer", () => {
    const out = accountStatusFanOutOf(
      refreshResult({ topstep: null, tradovate: [3] }, { topstep: "503" }),
    );
    expect(out.answered.has(BrokerKind.Topstep)).toBe(false);
    expect(out.failed).toEqual([BrokerKind.Topstep]);
  });

  // An arm the registry never ran leaves `errors` null, which is the same
  // value an answering arm leaves. Read as an answer, its empty list would mark
  // every account of an unconfigured broker inactive.
  it("reads an unconfigured broker as neither answered nor failed", () => {
    const out = accountStatusFanOutOf(refreshResult({ topstep: [1], tradovate: null }));
    expect([...out.answered.keys()]).toEqual([BrokerKind.Topstep]);
    expect(out.failed).toEqual([]);
  });

  it("takes an answering arm's empty list as an answer", () => {
    const out = accountStatusFanOutOf(refreshResult({ topstep: [], tradovate: null }));
    expect(out.answered.get(BrokerKind.Topstep)?.ids).toEqual([]);
  });
});

describe("the stored balance", () => {
  const SEARCH_AT = T0.toISOString();
  const WEBSITE_AT = "2026-10-14T21:00:07.000Z";
  const balanceOf = (id: number) => {
    const r = listAccountBalances().find((b) => b.accountId === id);
    return r && { balanceUsd: r.balanceUsd, balanceAt: r.balanceAt };
  };
  const withBalances = (result: RefreshResult, balances: Array<[number, number]>): RefreshResult => ({
    ...result,
    balances: { topstep: new Map(balances), tradovate: null },
  });

  it("writes Topstep's search balance, stamped when the search returned, even when the website answers the status", async () => {
    const fan = registryStatusFanOut({
      refresh: async () =>
        withBalances(refreshResult({ topstep: [1, 2], tradovate: [3] }), [
          [1, 150_250.5],
          [2, 48_722.9],
        ]),
      orphanAbsentAccounts: async () => {},
      hasOpenPosition: () => false,
      readTopstepAccounts: async () => ({
        ok: true,
        accounts: [websiteRecord({ accountId: 1 }), websiteRecord({ accountId: 2 })],
        at: WEBSITE_AT,
      }),
      logEvent: () => {},
    });
    const job = new AccountStatusJob({ fanOut: fan, logEvent: () => {} });

    await job.check();

    expect(balanceOf(1)).toEqual({ balanceUsd: 150_250.5, balanceAt: SEARCH_AT });
    expect(balanceOf(2)).toEqual({ balanceUsd: 48_722.9, balanceAt: SEARCH_AT });
    // Tradovate's account list carries no balance, so none is stored.
    expect(balanceOf(3)).toEqual({ balanceUsd: null, balanceAt: null });
  });

  it("writes nothing for a broker that did not answer — the last balance keeps its older stamp", async () => {
    const answered = registryStatusFanOut({
      refresh: async () => withBalances(refreshResult({ topstep: [1], tradovate: null }), [[1, 50_000]]),
      orphanAbsentAccounts: async () => {},
      hasOpenPosition: () => false,
      readTopstepAccounts: async () => WEBSITE_DOWN,
      logEvent: () => {},
    });
    await new AccountStatusJob({ fanOut: answered, logEvent: () => {} }).check();

    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    const down = registryStatusFanOut({
      refresh: async () => refreshResult({ topstep: null, tradovate: null }, { topstep: "503" }),
      orphanAbsentAccounts: async () => {},
      hasOpenPosition: () => false,
      readTopstepAccounts: async () => WEBSITE_DOWN,
      logEvent: () => {},
    });
    await new AccountStatusJob({ fanOut: down, logEvent: () => {} }).check();

    expect(balanceOf(1)).toEqual({ balanceUsd: 50_000, balanceAt: SEARCH_AT });
  });
});

describe("AccountStatusJob.runEveningPass", () => {
  const job = () => makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);

  it("does not run before 17:55 ET or from the 18:00 open", async () => {
    const { job: j, fan } = job();
    await j.runEveningPass(new Date("2026-10-14T21:54:59.000Z")); // 17:54:59 EDT
    await j.runEveningPass(new Date("2026-10-14T22:00:00.000Z")); // 18:00 EDT
    expect(fan).not.toHaveBeenCalled();
  });

  it("runs once per session day from 17:55 ET, and again the next weekday", async () => {
    const { job: j, fan } = job();
    await j.runEveningPass(new Date("2026-10-14T21:55:00.000Z")); // Wed 17:55 EDT
    await j.runEveningPass(new Date("2026-10-14T21:58:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(1);
    await j.runEveningPass(new Date("2026-10-15T21:56:00.000Z")); // Thu 17:56 EDT
    expect(fan).toHaveBeenCalledTimes(2);
  });

  it("reads the window in New York time across DST", async () => {
    const { job: j, fan } = job();
    // 2026-12-02 is in EST: 21:55Z is 16:55 there, 22:55Z is 17:55.
    await j.runEveningPass(new Date("2026-12-02T21:55:00.000Z"));
    expect(fan).not.toHaveBeenCalled();
    await j.runEveningPass(new Date("2026-12-02T22:55:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("does not run on a weekend", async () => {
    const { job: j, fan } = job();
    await j.runEveningPass(new Date("2026-10-17T21:55:00.000Z")); // Sat
    await j.runEveningPass(new Date("2026-10-18T21:55:00.000Z")); // Sun
    expect(fan).not.toHaveBeenCalled();
  });

  it("runs even when a clean check completed minutes ago", async () => {
    const { job: j, fan } = job();
    await j.check();
    await j.runEveningPass(new Date("2026-10-14T21:55:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(2);
  });

  it("retries on the window's next tick after a check that threw or was unclean, then stops", async () => {
    const { job: j, fan } = makeJob([
      new Error("registry down"),
      fanOut([], [BrokerKind.Topstep]),
      fanOut([[BrokerKind.Topstep, [1, 2]]]),
    ]);
    await expect(j.runEveningPass(new Date("2026-10-14T21:55:00.000Z"))).rejects.toThrow("registry down");
    await j.runEveningPass(new Date("2026-10-14T21:56:00.000Z"));
    await j.runEveningPass(new Date("2026-10-14T21:57:00.000Z"));
    await j.runEveningPass(new Date("2026-10-14T21:58:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(3);
  });
});

describe("AccountStatusJob.runOpenRecheck", () => {
  /** Account 1 stored locked with no end — the search's `canTrade: false`,
   *  the shape a daily-loss lock takes. */
  const lockWithoutEnd = () =>
    recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([1, 2], [1]), T0.toISOString());
  const job = () => makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);

  it("rechecks once just after the 18:00 open while an account is locked with no end", async () => {
    lockWithoutEnd();
    const { job: j, fan } = job();
    await j.runOpenRecheck(new Date("2026-10-14T22:00:00.000Z")); // 18:00 EDT: not yet
    expect(fan).not.toHaveBeenCalled();
    await j.runOpenRecheck(new Date("2026-10-14T22:01:00.000Z"));
    await j.runOpenRecheck(new Date("2026-10-14T22:02:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no account is locked without an end", async () => {
    const { job: j, fan } = job();
    await j.runOpenRecheck(new Date("2026-10-14T22:01:00.000Z"));
    expect(fan).not.toHaveBeenCalled();
  });

  // The daily-loss lock ends at the open, so the gates stop reading it then;
  // the recheck is what re-reads the account rather than leaving a stale row.
  it("rechecks a lock whose end has passed, and not one still running", async () => {
    const lockUntil = (until: string, checkedAt: string) =>
      recordAccountStates(
        BrokerKind.Topstep,
        {
          source: "website",
          accounts: [
            { accountId: 1, source: "website", state: "locked", cause: "website", statusCode: 0, lockoutReason: "x", lockoutUntil: until, facts: null },
          ],
        },
        checkedAt,
      );
    lockUntil("2026-10-15T22:00:00.000Z", "2026-10-14T21:00:01.000Z");
    const { job: running, fan: notYet } = job();
    await running.runOpenRecheck(new Date("2026-10-14T22:01:00.000Z"));
    expect(notYet).not.toHaveBeenCalled();

    lockUntil("2026-10-14T22:00:00.000Z", "2026-10-14T21:00:02.000Z");
    const { job: ended, fan } = job();
    await ended.runOpenRecheck(new Date("2026-10-14T22:01:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("runs on the days a session opens — Sunday yes, Friday and Saturday no — and not past 18:15", async () => {
    lockWithoutEnd();
    const { job: j, fan } = job();
    await j.runOpenRecheck(new Date("2026-10-16T22:01:00.000Z")); // Fri
    await j.runOpenRecheck(new Date("2026-10-17T22:01:00.000Z")); // Sat
    await j.runOpenRecheck(new Date("2026-10-15T22:15:00.000Z")); // Thu 18:15
    expect(fan).not.toHaveBeenCalled();
    await j.runOpenRecheck(new Date("2026-10-18T22:01:00.000Z")); // Sun
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("reads the window in New York time across DST", async () => {
    lockWithoutEnd();
    const { job: j, fan } = job();
    await j.runOpenRecheck(new Date("2026-12-02T22:01:00.000Z")); // 17:01 EST
    expect(fan).not.toHaveBeenCalled();
    await j.runOpenRecheck(new Date("2026-12-02T23:01:00.000Z")); // 18:01 EST
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("retries inside the window after an unclean check", async () => {
    lockWithoutEnd();
    const { job: j, fan } = makeJob([fanOut([], [BrokerKind.Topstep]), fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    await j.runOpenRecheck(new Date("2026-10-14T22:01:00.000Z"));
    await j.runOpenRecheck(new Date("2026-10-14T22:02:00.000Z"));
    await j.runOpenRecheck(new Date("2026-10-14T22:03:00.000Z"));
    expect(fan).toHaveBeenCalledTimes(2);
  });
});

describe("AccountStatusJob.noteTradeClosed", () => {
  it("runs one check after the wait, however many closes land inside it", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    job.noteTradeClosed();
    await vi.advanceTimersByTimeAsync(4_000);
    job.noteTradeClosed();
    job.noteTradeClosed();
    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS - 1);
    expect(fan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS * 3);
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("returns at once and never throws to its caller when the check fails; the failure is said", async () => {
    const { job, fan, events } = makeJob([new Error("registry down")]);
    expect(() => job.noteTradeClosed()).not.toThrow();
    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS);
    expect(fan).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({ event: "boot_broker_arm_failed", message: expect.stringContaining("registry down") }),
    ]);
  });

  it("cancelPending drops a check that has not started", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    job.noteTradeClosed();
    job.cancelPending();
    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS * 2);
    expect(fan).not.toHaveBeenCalled();
  });

  // A reconcile that was mid-flight when the engine stopped still books its
  // close afterwards; that close must schedule nothing until the next start.
  it("schedules nothing for a close booked after cancelPending, until arm()", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    job.cancelPending();
    job.noteTradeClosed();
    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS * 2);
    expect(fan).not.toHaveBeenCalled();

    job.arm();
    job.noteTradeClosed();
    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS);
    expect(fan).toHaveBeenCalledTimes(1);
  });
});

/**
 * The rejected-entry trigger (docs/bugs-fixed.md, "Engine keeps placing
 * entries against non-tradable accounts", fix pass). Each check is a registry
 * refresh, a website read and an orphan pass, so a 429 or a timeout must not
 * start one, and a rejection storm must not start one per bar.
 */
describe("AccountStatusJob.noteEntryRejected", () => {
  it("runs a check when the broker refused the order", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Tradovate, [1, 2]]])]);
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("runs a check when the broker says the account is unavailable", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    job.noteEntryRejected("account_unavailable", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("runs none on a rate limit, a network error, an auth failure, an open circuit or an error no broker owns", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    for (const kind of ["rate_limited", "network", "auth", "circuit_open", "captcha", null] as const) {
      job.noteEntryRejected(kind, 1);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).not.toHaveBeenCalled();
  });

  it("runs none within ACCOUNT_STATUS_REJECTION_SPACING_MS of the last check settling, and one after it", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ACCOUNT_STATUS_REJECTION_SPACING_MS - 1);
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(2);
  });

  it("counts a check another trigger ran toward the spacing", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    await job.check();
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("counts a check that threw toward the spacing, and says the throw once", async () => {
    const { job, fan, events } = makeJob([new Error("registry down")]);
    expect(() => job.noteEntryRejected("order_rejected", 1)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        event: "boot_broker_arm_failed",
        message: expect.stringContaining("registry down"),
        subject: { accountId: 1 },
      }),
    ]);
  });

  it("runs none while disarmed", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    job.cancelPending();
    job.noteEntryRejected("order_rejected", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fan).not.toHaveBeenCalled();
  });
});

/**
 * What the engine hands the job as its fan-out. Before, the engine read the
 * ids off the live registry and the `configured` flags off its own client
 * handles — both *after* `refreshBrokerRegistry()`'s later awaits, so a
 * concurrent refresh could change either under it.
 */
describe("registryStatusFanOut", () => {
  const noLog = () => {};

  function deps(over: Partial<RegistryStatusFanOutDeps>): RegistryStatusFanOutDeps {
    return {
      refresh: async () => refreshResult({ topstep: [1], tradovate: null }),
      orphanAbsentAccounts: async () => {},
      hasOpenPosition: () => false,
      readTopstepAccounts: async () => WEBSITE_DOWN,
      logEvent: noLog,
      ...over,
    } satisfies RegistryStatusFanOutDeps;
  }

  /** Each answering broker's accounts as `id → state`. */
  function statesOf(out: AccountStatusFanOut) {
    return [...out.answered].map(([kind, { answer }]) => [
      kind,
      answer.source,
      Object.fromEntries(answer.accounts.map((a) => [a.accountId, a.state])),
    ]);
  }

  it("answers from the refresh's own result, whatever the registry holds by then", async () => {
    const fan = registryStatusFanOut(
      deps({ refresh: async () => refreshResult({ topstep: [1], tradovate: [3] }) }),
    );
    expect(statesOf(await fan())).toEqual([
      [BrokerKind.Topstep, "search", { 1: "ok" }],
      [BrokerKind.Tradovate, "search", { 3: "ok" }],
    ]);
  });

  it("answers Topstep from its website read, stamped when that read returned", async () => {
    const at = "2026-10-14T21:00:07.000Z";
    const fan = registryStatusFanOut(
      deps({
        refresh: async () => refreshResult({ topstep: [1, 2], tradovate: [3] }),
        readTopstepAccounts: async () => ({
          ok: true,
          at,
          accounts: [websiteRecord({ accountId: 1 }), websiteRecord({ accountId: 2, ineligible: true, status: 2 })],
        }),
      }),
    );
    const out = await fan();
    expect(statesOf(out)).toEqual([
      [BrokerKind.Topstep, "website", { 1: "ok", 2: "dead" }],
      // Tradovate is read off its search, as before.
      [BrokerKind.Tradovate, "search", { 3: "ok" }],
    ]);
    expect(out.answered.get(BrokerKind.Topstep)?.at).toBe(at);
    expect(out.fallbacks).toEqual([]);
  });

  // `canTrade: false` is a violation or a lockout, and the search cannot say
  // which; locked keeps a lockout listed on Risk.
  it("falls back to the search's canTrade when the website read fails — unable to trade reads locked — and says why", async () => {
    const fan = registryStatusFanOut(
      deps({
        refresh: async () => refreshResult({ topstep: [1, 2], tradovate: null }, {}, { topstep: [2] }),
        readTopstepAccounts: async () => ({
          ok: false,
          kind: "shape",
          reason: "account record 2 of 5 has an unexpected shape",
        }),
      }),
    );
    const out = await fan();
    expect(statesOf(out)).toEqual([[BrokerKind.Topstep, "search", { 1: "ok", 2: "locked" }]]);
    const locked = out.answered.get(BrokerKind.Topstep)?.answer.accounts.find((a) => a.accountId === 2);
    expect(locked).toMatchObject({ lockoutReason: null, lockoutUntil: null });
    expect(out.answered.get(BrokerKind.Topstep)?.at).toBe(T0.toISOString());
    expect(out.answered.get(BrokerKind.Topstep)?.answer.accounts.every((a) => a.facts === null)).toBe(true);
    expect(out.fallbacks).toEqual([
      { broker: BrokerKind.Topstep, kind: "shape", reason: "account record 2 of 5 has an unexpected shape" },
    ]);
  });

  // A successful website answer that omits an account the search listed is
  // not evidence the account is dead; only one absent from both is.
  it("gives an account the website omitted the search's answer, and dead only to one absent from both", async () => {
    const at = "2026-10-14T21:00:07.000Z";
    const fan = registryStatusFanOut(
      deps({
        refresh: async () => refreshResult({ topstep: [1, 2], tradovate: null }),
        readTopstepAccounts: async () => ({ ok: true, at, accounts: [websiteRecord({ accountId: 1 })] }),
      }),
    );
    const out = await fan();
    const accounts = out.answered.get(BrokerKind.Topstep)?.answer.accounts ?? [];
    expect(accounts.map((a) => [a.accountId, a.state, a.source, a.facts === null])).toEqual([
      [1, "ok", "website", false],
      [2, "ok", "search", true],
    ]);
    expect(out.fallbacks).toEqual([]);

    const { job } = makeJob([out]);
    await job.check();
    expect(stored()[2]).toEqual({ state: "ok", checkedAt: at });

    // Listed by neither: dead.
    const laterAt = "2026-10-14T21:01:07.000Z";
    const neither = await registryStatusFanOut(
      deps({
        refresh: async () => refreshResult({ topstep: [1], tradovate: null }),
        readTopstepAccounts: async () => ({ ok: true, at: laterAt, accounts: [websiteRecord({ accountId: 1 })] }),
      }),
    )();
    const { job: second } = makeJob([neither]);
    expect((await second.check()).newlyDead).toEqual([2]);
    expect(stored()[2]).toEqual({ state: "dead", checkedAt: laterAt });
  });

  it("falls back the same way when the website read throws", async () => {
    const fan = registryStatusFanOut(
      deps({
        readTopstepAccounts: async () => {
          throw new Error("socket hang up");
        },
      }),
    );
    const out = await fan();
    expect(statesOf(out)).toEqual([[BrokerKind.Topstep, "search", { 1: "ok" }]]);
    expect(out.fallbacks).toEqual([{ broker: BrokerKind.Topstep, kind: "network", reason: "socket hang up" }]);
  });

  // A failed search is no answer at all, so there is nothing for the website
  // read to replace — and an unconfigured Topstep is not asked about.
  it("does not read the website when Topstep's search did not answer or was not run", async () => {
    const read = vi.fn(async () => WEBSITE_DOWN);
    await registryStatusFanOut(
      deps({
        refresh: async () => refreshResult({ topstep: null, tradovate: [3] }, { topstep: "503" }),
        readTopstepAccounts: read,
      }),
    )();
    await registryStatusFanOut(
      deps({ refresh: async () => refreshResult({ topstep: null, tradovate: [3] }), readTopstepAccounts: read }),
    )();
    expect(read).not.toHaveBeenCalled();
  });

  // The status refresh resets the reconciler's 30-minute clock, so without
  // this its orphan pass is skipped for a refresh nobody cross-checked.
  it("runs the orphan pass on that same result before answering", async () => {
    const result = refreshResult({ topstep: [1], tradovate: null }, { tradovate: "401" });
    const seen: RefreshResult[] = [];
    const order: string[] = [];
    const fan = registryStatusFanOut(
      deps({
        refresh: async () => {
          order.push("refresh");
          return result;
        },
        orphanAbsentAccounts: async (r) => {
          order.push("orphan pass");
          seen.push(r);
        },
      }),
    );
    await fan();
    expect(order).toEqual(["refresh", "orphan pass"]);
    expect(seen).toEqual([result]);
  });

  it("still answers when the orphan pass throws, and says the pass paused nothing", async () => {
    const events: Array<{ event: string; message: string }> = [];
    const fan = registryStatusFanOut(
      deps({
        orphanAbsentAccounts: async () => {
          throw new Error("database is locked");
        },
        logEvent: (event, message) => events.push({ event, message }),
      }),
    );
    await expect(fan()).resolves.toMatchObject({ failed: [] });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("orphan_check_skipped");
    expect(events[0]?.message).toContain("database is locked");
  });
});

/**
 * The two locks Topstep's website record does not show. Prod, 2026-10-21: a
 * 50K combine hit its $1,000 Daily Loss Limit (lost $1,041.66), Topstep locked
 * it until the 18:00 ET open, and the website record still read ok with no
 * lockout.
 */
describe("withTopstepSearchLocks", () => {
  /** Wednesday 2026-10-21 16:20 EDT — inside the session that opened Tue 18:00. */
  const AT = "2026-10-21T20:20:00.000Z";
  const NEXT_OPEN = "2026-10-21T22:00:00.000Z";
  const SOD = 51_713.79;

  type LockOpts = {
    at?: string;
    balanceAt?: string;
    cannotTrade?: number[];
    accountClass?: AccountClass;
    openPosition?: boolean;
  };

  function lockOf(record: Partial<TopstepTradingAccount>, balance: number, opts: LockOpts = {}) {
    const a = answerOf(record, balance, opts);
    return { state: a.state, lockoutReason: a.lockoutReason, lockoutUntil: a.lockoutUntil };
  }

  function answerOf(record: Partial<TopstepTradingAccount>, balance: number, opts: LockOpts = {}) {
    const at = opts.at ?? AT;
    const answer = topstepStatusAnswer([websiteRecord({ accountId: 2, startOfDayBalance: SOD, ...record })], at);
    const out = withTopstepSearchLocks(
      answer,
      {
        balances: new Map([[2, balance]]),
        balanceAt: opts.balanceAt ?? at,
        cannotTrade: opts.cannotTrade ?? [],
        accountClass: () => opts.accountClass ?? "COMBINE",
        hasOpenPosition: (id) => id === 2 && opts.openPosition === true,
      },
      at,
    );
    return out.accounts[0]!;
  }

  const causeOf = (record: Partial<TopstepTradingAccount>, balance: number, opts: LockOpts = {}) => {
    const a = answerOf(record, balance, opts);
    return [a.state, a.cause];
  };

  it("names each cause: daily loss, the canTrade backstop, the website's own, and none on an ok", () => {
    expect(causeOf({}, 50_672.13)).toEqual(["locked", "daily-loss"]);
    // The personal limit is the smaller one that tripped; the cause is the same.
    expect(causeOf({ personalDailyLossLimit: 500 }, SOD - 500)).toEqual(["locked", "daily-loss"]);
    expect(causeOf({}, SOD, { cannotTrade: [2] })).toEqual(["locked", "cannot-trade"]);
    expect(causeOf({ lockoutReason: "Manual lockout" }, SOD)).toEqual(["locked", "website"]);
    expect(causeOf({ ineligible: true, status: 2 }, 48_500)).toEqual(["dead", "website"]);
    expect(causeOf({}, SOD)).toEqual(["ok", null]);
  });

  describe("the personal daily profit target", () => {
    const TARGET = { personalDailyProfitTarget: 1_250 };

    it("locks until the next open at exactly the target, with its figures, and not one cent under", () => {
      expect(answerOf(TARGET, SOD + 1_250)).toMatchObject({
        state: "locked",
        cause: "profit-target",
        lockoutReason: "daily profit target reached: up $1,250.00 on a $1,250.00 target today",
        lockoutUntil: NEXT_OPEN,
      });
      expect(causeOf(TARGET, SOD + 1_249.99)).toEqual(["ok", null]);
      expect(profitTargetLockReason(130_000, 125_000)).toBe(
        "daily profit target reached: up $1,300.00 on a $1,250.00 target today",
      );
    });

    it("applies to Combine and XFA, never practice, funded or unclassified", () => {
      for (const accountClass of ["COMBINE", "XFA"] as const) {
        expect(causeOf(TARGET, SOD + 2_000, { accountClass })).toEqual(["locked", "profit-target"]);
      }
      for (const accountClass of ["PRAC", "LIVE", "UNKNOWN"] as const) {
        expect(causeOf(TARGET, SOD + 2_000, { accountClass })).toEqual(["ok", null]);
      }
    });

    it("reads no target that is zero, negative or missing", () => {
      for (const personalDailyProfitTarget of [0, -100, null]) {
        expect(causeOf({ personalDailyProfitTarget }, SOD + 5_000).at(0)).toBe("ok");
      }
    });

    it("keeps the daily-loss rule's session guards: no compare before the open plus 30 minutes", () => {
      expect(causeOf(TARGET, SOD + 2_000, { balanceAt: "2026-10-20T21:59:59.000Z" }).at(0)).toBe("ok");
      expect(causeOf(TARGET, SOD + 2_000, { at: "2026-10-21T22:29:59.000Z" }).at(0)).toBe("ok");
      expect(causeOf(TARGET, SOD + 2_000, { at: "2026-10-21T22:30:00.000Z" }).at(0)).toBe("locked");
    });
  });

  // Operator, 2026-10-21: Max Loss is a label only. It never creates a refusal.
  describe("the maximum-loss floor", () => {
    const DEAD = { ineligible: true, status: 2 };

    it("names a website dead's cause at exactly the floor with its figures, and not one cent over", () => {
      expect(answerOf(DEAD, 48_000)).toMatchObject({
        state: "dead",
        cause: "max-loss",
        lockoutReason: "maximum loss limit reached: balance $48,000.00 is at or under its $48,000.00 floor",
        lockoutUntil: null,
      });
      expect(causeOf(DEAD, 48_000.01)).toEqual(["dead", "website"]);
      expect(maxLossReason(4_799_999, 4_800_000)).toBe(
        "maximum loss limit reached: balance $47,999.99 is at or under its $48,000.00 floor",
      );
    });

    it("never turns a website ok dead, on any class, at or under the floor", () => {
      for (const accountClass of ["COMBINE", "XFA", "PRAC", "LIVE", "UNKNOWN"] as const) {
        expect(causeOf({ dailyLoss: 0 }, 47_000, { accountClass })).toEqual(["ok", null]);
      }
    });

    it("never touches a running website lockout", () => {
      expect(causeOf({ lockoutReason: "Manual lockout" }, 47_000)).toEqual(["locked", "website"]);
    });

    it("reads no floor that is zero, negative or missing", () => {
      for (const maximumLoss of [0, -1, null]) {
        expect(causeOf({ ...DEAD, maximumLoss }, 10)).toEqual(["dead", "website"]);
      }
    });
  });

  // The search balance is realized only; Topstep's limits count open P&L.
  // With a sibling leg open, realized can cross a limit that net has not.
  describe("with a position open on the account", () => {
    it("locks neither the daily loss nor the profit target, and does once the account is flat", () => {
      const target = { personalDailyProfitTarget: 1_250 };
      expect(causeOf({}, 50_672.13, { openPosition: true })).toEqual(["ok", null]);
      expect(causeOf(target, SOD + 2_000, { openPosition: true })).toEqual(["ok", null]);
      expect(causeOf({}, 50_672.13)).toEqual(["locked", "daily-loss"]);
      expect(causeOf(target, SOD + 2_000)).toEqual(["locked", "profit-target"]);
    });

    it("still reads canTrade: false as locked — Topstep's own flag counts its own P&L", () => {
      expect(causeOf({}, SOD, { openPosition: true, cannotTrade: [2] })).toEqual(["locked", "cannot-trade"]);
    });

    it("asks the fan-out's predicate per account, at the compare", async () => {
      vi.setSystemTime(new Date(AT));
      const result = refreshResult({ topstep: [1, 2], tradovate: null });
      result.answeredAt.topstep = AT;
      result.balances.topstep = new Map([[2, 48_500]]);
      const asked: number[] = [];
      const out = await registryStatusFanOut({
        refresh: async () => result,
        orphanAbsentAccounts: async () => {},
        hasOpenPosition: (id) => {
          asked.push(id);
          return id === 2;
        },
        readTopstepAccounts: async () => ({
          ok: true,
          at: AT,
          accounts: [websiteRecord({ accountId: 2, startOfDayBalance: SOD })],
        }),
        logEvent: () => {},
      })();
      expect(out.answered.get(BrokerKind.Topstep)?.answer.accounts.find((a) => a.accountId === 2)?.state).toBe("ok");
      expect(asked).toContain(2);
    });
  });

  // Outside a session canTrade: false is ignored, and must not flap a stored
  // lock through ok: locked at 16:59, ok at 17:55, locked again at 18:00.
  it("marks canTrade: false in the halt and the weekend gap to hold the stored lock, and only then", () => {
    expect(answerOf({}, SOD, { at: "2026-10-21T21:30:00.000Z", cannotTrade: [2] })).toMatchObject({
      state: "ok",
      holdStoredLock: true,
    });
    expect(answerOf({}, SOD, { at: "2026-10-24T16:00:00.000Z", cannotTrade: [2] }).holdStoredLock).toBe(true);
    expect(answerOf({}, SOD, { at: "2026-10-21T21:30:00.000Z" }).holdStoredLock).toBeUndefined();
    expect(answerOf({}, SOD, { cannotTrade: [] }).holdStoredLock).toBeUndefined();
  });

  it("locks the prod case until the next 18:00 ET open, saying what was lost of what", () => {
    expect(lockOf({}, 50_672.13)).toEqual({
      state: "locked",
      lockoutReason: "daily loss limit reached: lost $1,041.66 of a $1,000.00 limit today",
      lockoutUntil: NEXT_OPEN,
    });
    expect(dailyLossLockReason(104_166, 100_000)).toBe(
      "daily loss limit reached: lost $1,041.66 of a $1,000.00 limit today",
    );
  });

  it("locks at exactly the limit and not one cent under", () => {
    expect(lockOf({}, 50_713.79).state).toBe("locked");
    expect(lockOf({}, 50_713.8).state).toBe("ok");
    // In doubles this loss is 1,041.6599999999962 — under the limit.
    const odd = { startOfDayBalance: 50_041.67, dailyLoss: null, personalDailyLossLimit: 1_041.66 };
    expect(lockOf(odd, 49_000.01).state).toBe("locked");
    expect(lockOf(odd, 49_000.02).state).toBe("ok");
  });

  it("takes the smallest positive of the daily loss limit and the personal one", () => {
    expect(lockOf({ personalDailyLossLimit: 500 }, SOD - 500)).toMatchObject({
      state: "locked",
      lockoutReason: "daily loss limit reached: lost $500.00 of a $500.00 limit today",
    });
    expect(lockOf({ dailyLoss: 400, personalDailyLossLimit: 900 }, SOD - 400).state).toBe("locked");
    // A non-positive personal limit is no limit; the daily one still stands.
    expect(lockOf({ personalDailyLossLimit: 0 }, SOD - 600).state).toBe("ok");
    expect(lockOf({ personalDailyLossLimit: -50 }, SOD - 600).state).toBe("ok");
  });

  it("never locks on a zero or missing limit — practice's 0", () => {
    // Above the $48,000 maximum-loss floor, so only the daily rule is asked.
    expect(lockOf({ dailyLoss: 0, personalDailyLossLimit: null }, SOD - 3_000).state).toBe("ok");
    expect(lockOf({ dailyLoss: null, personalDailyLossLimit: null }, SOD - 3_000).state).toBe("ok");
    expect(lockOf({ dailyLoss: 0, personalDailyLossLimit: 0 }, SOD - 3_000).state).toBe("ok");
    expect(lockOf({ startOfDayBalance: null }, 48_500).state).toBe("ok");
  });

  it("never compares a balance read before the current session's 18:00 ET open", () => {
    expect(lockOf({}, 50_000, { balanceAt: "2026-10-20T21:59:59.000Z" }).state).toBe("ok");
    // The race the rule is for: the search answered a second before the open,
    // the website a second after.
    expect(
      lockOf({}, 50_000, { at: "2026-10-20T22:00:01.000Z", balanceAt: "2026-10-20T21:59:59.000Z" }).state,
    ).toBe("ok");
    expect(lockOf({}, 50_000, { balanceAt: "2026-10-20T22:30:00.000Z" }).state).toBe("locked");
  });

  // The 18:01 post-open recheck: Topstep has lifted the lock, and when it rolls
  // `startOfDayBalance` to the new session is unobserved. Comparing the new
  // balance with yesterday's figure would re-lock the account for a day.
  it("does not compare a balance read in the first half hour after the open", () => {
    const opened = "2026-10-21T22:01:00.000Z"; // Wed 18:01 EDT
    expect(lockOf({}, 50_672.13, { at: opened }).state).toBe("ok");
    expect(lockOf({}, 50_672.13, { at: "2026-10-21T22:29:59.000Z" }).state).toBe("ok");
    expect(lockOf({}, 50_672.13, { at: "2026-10-21T22:30:00.000Z" }).state).toBe("locked");
  });

  // A payout or withdrawal drops the balance with the start-of-day figure
  // unchanged, which reads as a day's loss on any account that can take one.
  it("applies the daily loss rule to a Combine only — never XFA, funded, practice or unclassified", () => {
    expect(lockOf({}, 48_500, { accountClass: "COMBINE" }).state).toBe("locked");
    for (const accountClass of ["XFA", "LIVE", "PRAC", "UNKNOWN"] as const) {
      expect(lockOf({}, 48_500, { accountClass }).state).toBe("ok");
    }
  });

  it("classifies through the catalogue in the fan-out: a practice account with the same loss stays ok", async () => {
    vi.setSystemTime(new Date(AT));
    const result = refreshResult({ topstep: [1, 2], tradovate: null });
    result.answeredAt.topstep = AT;
    result.balances.topstep = new Map([
      [1, 48_500],
      [2, 48_500],
    ]);
    const out = await registryStatusFanOut({
      refresh: async () => result,
      orphanAbsentAccounts: async () => {},
      hasOpenPosition: () => false,
      readTopstepAccounts: async () => ({
        ok: true,
        at: AT,
        accounts: [websiteRecord({ accountId: 1, startOfDayBalance: SOD }), websiteRecord({ accountId: 2, startOfDayBalance: SOD })],
      }),
      logEvent: () => {},
    })();
    const states = out.answered.get(BrokerKind.Topstep)?.answer.accounts.map((a) => [a.accountId, a.state]);
    // 1 is `PRAC-…`, 2 is `50KTC-…` in the catalogue.
    expect(states).toEqual([
      [1, "ok"],
      [2, "locked"],
    ]);
  });

  it("does not read canTrade: false as a lock in the 17:00–18:00 ET halt or the weekend gap", () => {
    for (const at of [
      "2026-10-21T21:30:00.000Z", // Wed 17:30 EDT, the halt
      "2026-10-23T21:30:00.000Z", // Fri 17:30 EDT
      "2026-10-24T16:00:00.000Z", // Sat
      "2026-10-25T21:59:00.000Z", // Sun 17:59 EDT
      "2026-12-02T22:30:00.000Z", // Wed 17:30 EST
    ]) {
      expect(lockOf({}, SOD, { at, cannotTrade: [2] }).state).toBe("ok");
    }
    expect(lockOf({}, SOD, { at: "2026-10-25T22:00:00.000Z", cannotTrade: [2] }).state).toBe("locked");
  });

  it("ends the lock at the next 18:00 ET open across DST, over the weekend", () => {
    const until = (at: string) => lockOf({}, 50_000, { at }).lockoutUntil;
    // Friday afternoon EDT → Sunday 18:00 EST, after the fall-back.
    expect(until("2026-10-30T19:00:00.000Z")).toBe("2026-11-01T23:00:00.000Z");
    // Saturday, the weekend gap → the same Sunday open.
    expect(until("2026-10-31T16:00:00.000Z")).toBe("2026-11-01T23:00:00.000Z");
    // Friday afternoon EST → Sunday 18:00 EDT, after the spring-forward.
    expect(until("2027-03-12T20:00:00.000Z")).toBe("2027-03-14T22:00:00.000Z");
    // Inside the weekday break, still today's open.
    expect(until("2026-12-02T22:30:00.000Z")).toBe("2026-12-02T23:00:00.000Z");
  });

  it("never upgrades a dead account, nor overrides a website lockout that has its own reason and end", () => {
    expect(lockOf({ ineligible: true, status: 2 }, 48_500, { cannotTrade: [2] })).toEqual({
      state: "dead",
      lockoutReason: null,
      lockoutUntil: null,
    });
    const own = { lockoutReason: "Manual lockout", lockoutExpiration: "2026-10-23T12:00:00Z" };
    expect(lockOf(own, 40_000, { cannotTrade: [2] })).toEqual({
      state: "locked",
      lockoutReason: "Manual lockout",
      lockoutUntil: "2026-10-23T12:00:00.000Z",
    });
  });

  it("reads canTrade: false over a website ok as locked with no end", () => {
    expect(lockOf({}, SOD, { cannotTrade: [2] })).toEqual({
      state: "locked",
      lockoutReason: CANNOT_TRADE_LOCK_REASON,
      lockoutUntil: null,
    });
    expect(lockOf({}, SOD, { cannotTrade: [] }).state).toBe("ok");
  });

  it("is what the fan-out answers Topstep with, from the same refresh's balance and canTrade", async () => {
    vi.setSystemTime(new Date(AT));
    const result = refreshResult({ topstep: [1, 2], tradovate: null }, {}, { topstep: [1] });
    result.answeredAt.topstep = AT;
    result.balances.topstep = new Map([
      [1, 48_722.9],
      [2, 50_672.13],
    ]);
    const out = await registryStatusFanOut({
      refresh: async () => result,
      orphanAbsentAccounts: async () => {},
      hasOpenPosition: () => false,
      readTopstepAccounts: async () => ({
        ok: true,
        at: AT,
        accounts: [websiteRecord({ accountId: 1 }), websiteRecord({ accountId: 2, startOfDayBalance: SOD })],
      }),
      logEvent: () => {},
    })();
    const accounts = out.answered.get(BrokerKind.Topstep)?.answer.accounts ?? [];
    expect(accounts.map((a) => [a.accountId, a.state, a.lockoutUntil])).toEqual([
      [1, "locked", null],
      [2, "locked", NEXT_OPEN],
    ]);
  });
});

// A failed website read's fallback reads a daily-loss-locked account `ok` off
// the search; written through, it would unlock the account before the open.
describe("a stored daily-loss lock under a search fallback", () => {
  const UNTIL = "2026-10-14T22:00:00.000Z"; // T0 is 17:00 EDT, so an hour ahead
  const lockOf = (id: number) => {
    const r = listAccountRiskPostures().find((p) => p.accountId === id)!;
    return { state: r.status.state, reason: r.status.lockoutReason, until: r.status.lockoutUntil, checkedAt: r.status.checkedAt };
  };

  beforeEach(() => {
    recordAccountStates(
      BrokerKind.Topstep,
      {
        source: "website",
        accounts: [
          { accountId: 1, source: "website", state: "ok", cause: null, statusCode: 0, lockoutReason: null, lockoutUntil: null, facts: null },
          {
            accountId: 2,
            source: "website",
            state: "locked",
            cause: "daily-loss",
            statusCode: 0,
            lockoutReason: dailyLossLockReason(104_166, 100_000),
            lockoutUntil: UNTIL,
            facts: null,
          },
        ],
      },
      "2026-10-14T20:00:00.000Z",
    );
  });

  it("keeps the lock whole while its end is ahead, and only the stamp moves", () => {
    recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([1, 2], []), "2026-10-14T21:00:00.000Z");
    expect(lockOf(2)).toEqual({
      state: "locked",
      reason: dailyLossLockReason(104_166, 100_000),
      until: UNTIL,
      checkedAt: "2026-10-14T21:00:00.000Z",
    });
  });

  it("takes the search's answer once the end has passed", () => {
    recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([1, 2], []), "2026-10-14T22:00:01.000Z");
    expect(lockOf(2).state).toBe("ok");
  });

  it("does not keep it over an account the search no longer lists", () => {
    recordAccountStates(BrokerKind.Topstep, accountStatesFromSearch([1], []), "2026-10-14T21:00:00.000Z");
    expect(lockOf(2).state).toBe("dead");
  });
});

describe("AccountStatusJob.check", () => {
  it("writes each answering broker's accounts and stamps them with the answer's time", async () => {
    const { job } = makeJob([fanOut([[BrokerKind.Topstep, [1]]])]);
    const result = await job.check();
    expect(result).toEqual({
      checkedAt: T0.toISOString(),
      answered: [BrokerKind.Topstep],
      failed: [],
      newlyDead: [2],
      clean: true,
    });
    expect(stored()).toEqual({
      1: { state: "ok", checkedAt: T0.toISOString() },
      2: { state: "dead", checkedAt: T0.toISOString() },
      3: { state: null, checkedAt: null },
    });
  });

  // The orphan pass runs between the search and the write, so the time the
  // check settles is later than the answer. Stamped with the settle time, a
  // stale "dead" would outrank a refresh that listed the account since.
  it("stamps each broker's rows with the time that broker answered, not when the check settled", async () => {
    const answeredAt = "2026-10-14T20:59:30.000Z";
    const { job } = makeJob([
      {
        answered: new Map([
          [BrokerKind.Topstep, { answer: accountStatesFromSearch([1], []), at: answeredAt }],
        ]),
        failed: [],
        fallbacks: [],
      },
    ]);
    await job.check();
    expect(stored()[2]).toEqual({ state: "dead", checkedAt: answeredAt });
  });

  it("says once that the website read fell back, until a check reads it again", async () => {
    const fallback: AccountStatusFanOut = {
      ...fanOut([[BrokerKind.Topstep, [1, 2]]]),
      fallbacks: [{ broker: BrokerKind.Topstep, kind: "http", reason: "HTTP 503" }],
    };
    const { job, events } = makeJob([fallback, fallback, fanOut([[BrokerKind.Topstep, [1, 2]]]), fallback]);
    await job.check();
    await job.check();
    expect(events.map((e) => e.event)).toEqual(["boot_broker_arm_failed"]);
    expect(events[0]?.message).toContain("website account read failed (website error: HTTP 503");
    await job.check();
    await job.check();
    expect(events).toHaveLength(2);
  });

  // Prod has to show how often each failure happens — an expired cached token
  // most of all, since the read never mints — so the line names the kind and
  // counts every fallback of it, said or throttled.
  it("names the fallback's kind and how many times that kind has happened", async () => {
    const of = (kind: "expired" | "unauthorized", reason: string): AccountStatusFanOut => ({
      ...fanOut([[BrokerKind.Topstep, [1, 2]]]),
      fallbacks: [{ broker: BrokerKind.Topstep, kind, reason }],
    });
    const expired = of("expired", "the cached Topstep session token has expired");
    const refused = of("unauthorized", "HTTP 401");
    const { job, events } = makeJob([expired, expired, refused, expired]);
    for (let i = 0; i < 4; i += 1) await job.check();
    expect(events.map((e) => e.message.match(/\(([^;]+); (\d+)(?:st|nd|rd|th) time/)?.slice(1, 3))).toEqual([
      ["session token expired: the cached Topstep session token has expired", "1"],
      ["token refused: HTTP 401", "1"],
      ["session token expired: the cached Topstep session token has expired", "3"],
    ]);
  });

  it("changes nothing stored for a broker that did not answer", async () => {
    const { job } = makeJob([
      fanOut([[BrokerKind.Topstep, [1]]]),
      fanOut([[BrokerKind.Tradovate, [3]]], [BrokerKind.Topstep]),
    ]);
    await job.check();
    const before = stored();

    vi.setSystemTime(T0.getTime() + 60_000);
    const result = await job.check();

    expect(result.failed).toEqual([BrokerKind.Topstep]);
    expect(stored()[1]).toEqual(before[1]);
    expect(stored()[2]).toEqual(before[2]);
    // The broker that did answer is written as usual.
    expect(stored()[3]?.state).toBe("ok");
  });

  it("changes nothing stored when the fan-out throws, and rejects", async () => {
    const { job } = makeJob([fanOut([[BrokerKind.Topstep, [1]]]), new Error("registry down")]);
    await job.check();
    const before = stored();
    await expect(job.check()).rejects.toThrow("registry down");
    expect(stored()).toEqual(before);
  });

  it("joins a check already running instead of fanning out twice", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    const [a, b] = await Promise.all([job.check(), job.check()]);
    expect(fan).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    // And a check after it settles is a new one.
    await job.check();
    expect(fan).toHaveBeenCalledTimes(2);
  });

  it("says once that a broker did not answer, however many retries see the same outage", async () => {
    const { job, events } = makeJob([
      fanOut([], [BrokerKind.Topstep]),
      fanOut([], [BrokerKind.Topstep]),
      fanOut([[BrokerKind.Topstep, [1, 2]]]),
      fanOut([], [BrokerKind.Topstep]),
    ]);
    await job.check();
    await job.check();
    expect(events).toEqual([
      {
        event: "boot_broker_arm_failed",
        message:
          "Account status check: topstep did not answer, so its accounts keep the status the last check gave them.",
      },
    ]);
    // A clean check re-arms the line for the next outage.
    await job.check();
    await job.check();
    expect(events).toHaveLength(2);
  });
});

/**
 * End to end, through a real registry and the real table. Topstep's
 * active-only search lists account 2 although its website says it is
 * ineligible — the case the website read exists for.
 */
describe("a Topstep account its search still lists but its website calls dead", () => {
  function account(id: number, broker: "topstep" | "tradovate"): Account {
    return { id, name: `ACC-${id}`, balance: 50_000, canTrade: true, isVisible: true, broker, practice: true };
  }

  function job(registry: BrokerRegistry, readTopstepAccounts: RegistryStatusFanOutDeps["readTopstepAccounts"]) {
    return new AccountStatusJob({
      fanOut: registryStatusFanOut({
        refresh: () => registry.refresh(),
        orphanAbsentAccounts: async () => {},
        hasOpenPosition: () => false,
        readTopstepAccounts,
        logEvent: () => {},
      }),
      logEvent: () => {},
    });
  }

  const websiteSays = async (): Promise<TopstepTradingAccountsAnswer> => ({
    ok: true,
    at: new Date().toISOString(),
    accounts: [websiteRecord({ accountId: 1 }), websiteRecord({ accountId: 2, ineligible: true, status: 6 })],
  });

  it("is recorded dead and left off Risk, while an armed one stays listed", async () => {
    const registry = new BrokerRegistry({
      topstep: {
        searchAccounts: vi.fn(async () => [account(1, "topstep"), account(2, "topstep")]),
      } as Pick<TopstepClient, "searchAccounts"> as TopstepClient,
      tradovate: null,
    });
    await job(registry, websiteSays).check();

    const rows = listAccountRiskPostures();
    expect(rows.map((r) => [r.accountId, r.status.state, r.status.statusCode])).toEqual([
      [1, "ok", 0],
      [2, "dead", 6],
      [3, null, null],
    ]);
    // Every seeded account is practice, so staging would list all three.
    const staging = { production: false };
    expect(rows.filter((r) => listedOnRisk(r, staging)).map((r) => r.accountId)).toEqual([1, 3]);
    expect(getBrokerAccountFacts(2)?.autoOcoBrackets).toBe(true);

    setAccountRiskPosture(2, { maxRiskPerTradeUsd: 350, maxContracts: 3 });
    const armed = listAccountRiskPostures().find((r) => r.accountId === 2);
    expect(armed && listedOnRisk(armed, staging)).toBe(true);
  });

  // The first cut's refresh marked every listed id active, which on Topstep
  // revived a dead account on the next 30-minute refresh — and a refresh
  // stalled on its Tradovate arm did so with an older answer too.
  it("is not revived by a later refresh that lists it, stalled or not", async () => {
    let releaseTradovate: (accounts: Account[]) => void = () => {};
    const tradovateSearch = vi
      .fn<() => Promise<Account[]>>()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseTradovate = resolve)))
      .mockResolvedValue([account(3, "tradovate")]);
    const registry = new BrokerRegistry({
      topstep: {
        searchAccounts: vi.fn(async () => [account(1, "topstep"), account(2, "topstep")]),
      } as Pick<TopstepClient, "searchAccounts"> as TopstepClient,
      tradovate: { searchAccounts: tradovateSearch } as Pick<
        TradovateClient,
        "searchAccounts"
      > as TradovateClient,
    });

    const stalled = registry.refresh();
    while (tradovateSearch.mock.calls.length === 0) await Promise.resolve();

    vi.setSystemTime(T0.getTime() + 60_000);
    await job(registry, websiteSays).check();
    const checkedAt = new Date(T0.getTime() + 60_000).toISOString();
    expect(stored()[2]).toEqual({ state: "dead", checkedAt });

    vi.setSystemTime(T0.getTime() + 120_000);
    releaseTradovate([account(3, "tradovate")]);
    await stalled;
    await registry.refresh();

    expect(stored()[2]).toEqual({ state: "dead", checkedAt });
    // Tradovate's listing still heals its own account on a refresh.
    expect(stored()[3]?.state).toBe("ok");
  });
});

describe("AccountStatusJob.runDailyPass", () => {
  it("checks on its first pass, then not again until a day has gone by", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0.getTime() + ACCOUNT_STATUS_CHECK_PERIOD_MS - ACCOUNT_STATUS_JOB_INTERVAL_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0.getTime() + ACCOUNT_STATUS_CHECK_PERIOD_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(2);
  });

  it("counts a check the Settings page ran as the day's check", async () => {
    const { job, fan } = makeJob([fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    await job.check();
    vi.setSystemTime(T0.getTime() + ACCOUNT_STATUS_JOB_INTERVAL_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(1);
  });

  it("retries on the next pass after a check a broker failed, rather than waiting a day", async () => {
    const { job, fan } = makeJob([
      fanOut([], [BrokerKind.Topstep]),
      fanOut([[BrokerKind.Topstep, [1, 2]]]),
    ]);
    await job.runDailyPass(new Date());
    vi.setSystemTime(T0.getTime() + ACCOUNT_STATUS_JOB_INTERVAL_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(2);
  });

  // A stale cached token is a fallback, and the read never mints: the hourly
  // retry is what gives it a fresh token to try with.
  it("retries on the next pass after a check whose website read fell back", async () => {
    const fallback: AccountStatusFanOut = {
      ...fanOut([[BrokerKind.Topstep, [1, 2]]]),
      fallbacks: [{ broker: BrokerKind.Topstep, kind: "expired", reason: "expired" }],
    };
    const { job, fan } = makeJob([fallback, fanOut([[BrokerKind.Topstep, [1, 2]]])]);
    await job.runDailyPass(new Date());
    vi.setSystemTime(T0.getTime() + ACCOUNT_STATUS_JOB_INTERVAL_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(2);
    // And a clean one stands for the day.
    vi.setSystemTime(T0.getTime() + 2 * ACCOUNT_STATUS_JOB_INTERVAL_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(2);
  });

  // The after-close and evening checks run outside the daily pass, so an
  // unclean one can land inside a clean one's day: it must not be waited out.
  it("retries on the next pass after an unclean check that follows a clean one", async () => {
    const { job, fan } = makeJob([
      fanOut([[BrokerKind.Topstep, [1, 2]]]),
      fanOut([], [BrokerKind.Topstep]),
      fanOut([[BrokerKind.Topstep, [1, 2]]]),
    ]);
    await job.runDailyPass(new Date());
    await job.check();
    vi.setSystemTime(T0.getTime() + ACCOUNT_STATUS_JOB_INTERVAL_MS);
    await job.runDailyPass(new Date());
    expect(fan).toHaveBeenCalledTimes(3);
  });
});

/**
 * The daily pass is armed by the engine, which this suite cannot construct
 * cheaply. Read from source instead (testing/patterns.md, "enumerate the
 * sites from source"): armed beside the close sampler in both `start()`
 * branches, on its own interval, through `runDailyPass`, and cleared by
 * `stop()`.
 */
describe("the engine registers the daily pass", () => {
  const src = readFileSync(join(__dirname, "engine.ts"), "utf8");

  it("arms it wherever the close sampler is armed", () => {
    const samplerStarts = src.match(/this\.startSessionCloseSampler\(\);/g) ?? [];
    const statusStarts = src.match(/this\.startAccountStatusJob\(\);/g) ?? [];
    expect(samplerStarts.length).toBeGreaterThan(0);
    expect(statusStarts.length).toBe(samplerStarts.length);
  });

  it("runs runDailyPass on ACCOUNT_STATUS_JOB_INTERVAL_MS", () => {
    const arm = src.slice(src.indexOf("private startAccountStatusJob(): void {"));
    const body = arm.slice(0, arm.indexOf("\n  }\n"));
    expect(body).toContain("this.accountStatusJob.runDailyPass()");
    expect(body).toContain("ACCOUNT_STATUS_JOB_INTERVAL_MS");
    expect(body).toContain(".catch(");
  });

  // A fresh boot has stored no website answer yet, so every Topstep deploy
  // reads OCO-unknown until a check runs; waiting for the first interval was
  // an hour of refusals.
  it("runs one pass when it is armed, before the interval's first tick", () => {
    const arm = src.slice(src.indexOf("private startAccountStatusJob(): void {"));
    const body = arm.slice(0, arm.indexOf("\n  }\n"));
    const firstPass = body.indexOf("runPass();");
    expect(firstPass).toBeGreaterThan(-1);
    expect(firstPass).toBeLessThan(body.indexOf("setInterval(runPass, ACCOUNT_STATUS_JOB_INTERVAL_MS)"));
    // Still guarded, so a second start() arms nothing and runs nothing.
    expect(body.indexOf("if (this.accountStatusInterval) return;")).toBeLessThan(firstPass);
  });

  it("is cleared by stop()", () => {
    const stop = src.slice(src.indexOf("  stop(): void {"));
    const body = stop.slice(0, stop.indexOf("\n  }\n"));
    expect(body).toContain("clearInterval(this.accountStatusInterval)");
  });

  it("arms the evening pass beside it, and stop() disarms it and drops a pending after-close check", () => {
    const arm = src.slice(src.indexOf("private startAccountStatusJob(): void {"));
    const body = arm.slice(0, arm.indexOf("\n  }\n"));
    expect(body).toContain("this.accountStatusJob.runEveningPass()");
    expect(body).toContain("this.accountStatusJob.runOpenRecheck()");
    expect(body).toContain("ACCOUNT_STATUS_EVENING_INTERVAL_MS");
    // Re-armed on start, before the first pass.
    expect(body.indexOf("this.accountStatusJob.arm();")).toBeGreaterThan(-1);
    expect(body.indexOf("this.accountStatusJob.arm();")).toBeLessThan(body.indexOf("runPass();"));
    const stop = src.slice(src.indexOf("  stop(): void {"));
    const stopBody = stop.slice(0, stop.indexOf("\n  }\n"));
    expect(stopBody).toContain("clearInterval(this.accountStatusEveningInterval)");
    expect(stopBody).toContain("this.accountStatusJob.cancelPending()");
  });

  it("hands the reconciler the after-close trigger", () => {
    expect(src).toContain("noteTradeClosed: () => this.accountStatusJob.noteTradeClosed()");
  });

  // The owning plugin's classification, the one maybeOrphanFromBrokerError
  // reads, so an error no broker owns reaches the job as null and runs nothing.
  it("hands the rejected-entry trigger the owning broker's classification of the error", () => {
    expect(src).toContain(
      "this.accountStatusJob.noteEntryRejected(this.pluginOwningError(err)?.classifyError(err) ?? null, accountId)",
    );
  });

  // The behaviour is pinned on `registryStatusFanOut` above; this pins that
  // the engine uses it, with its own refresh and the shared orphan pass, and
  // reads nothing off its registry or client handles after the await.
  it("builds its fan-out from registryStatusFanOut over its own refresh and orphan pass", () => {
    const start = src.indexOf("this.accountStatusJob = new AccountStatusJob({");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n    });\n", start));
    expect(block).toContain("registryStatusFanOut({");
    expect(block).toContain("refresh: () => this.refreshBrokerRegistry()");
    expect(block).toContain("orphanAbsentAccounts: (result) => this.orphanAbsentAccountsAfter(result");
    for (const racy of ["accountIdsForKind", "tradovateClients", "topstepClient"]) {
      expect(block).not.toContain(racy);
    }
  });

  // Without it a sibling leg's realized P&L would lock every leg on the account.
  it("hands the fan-out the engine's per-account open-position test, off the contract locks", () => {
    const start = src.indexOf("this.accountStatusJob = new AccountStatusJob({");
    const block = src.slice(start, src.indexOf("\n    });\n", start));
    expect(block).toContain("hasOpenPosition: (accountId) => this.hasOpenPositionOnAccount(accountId)");
    const at = src.indexOf("private hasOpenPositionOnAccount(accountId: number): boolean {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf("\n  }\n", at))).toContain("this.contractLocks.keys()");
  });

  // Without the subject the line carries no structural account id.
  it("passes the job's account subject through to the engine's log", () => {
    const start = src.indexOf("this.accountStatusJob = new AccountStatusJob({");
    const block = src.slice(start, src.indexOf("\n    });\n", start));
    expect(block).toContain("logEvent: (event, message, subject) => this.logEvent(event, ENGINE_CTX, message, subject)");
  });
});

describe("account_state_changed — one line per stored change", () => {
  const LOST = dailyLossLockReason(104_166, 100_000);
  const NEXT_OPEN = "2026-10-14T22:00:00.000Z"; // Wed 18:00 EDT

  /** Topstep's whole answer for its two catalogued accounts, 1 always ok. */
  function topstepFan(two: Partial<AccountStateAnswer> | null, at: string): AccountStatusFanOut {
    const ok = (accountId: number): AccountStateAnswer => ({
      accountId,
      source: "website",
      state: "ok",
      cause: null,
      statusCode: 0,
      lockoutReason: null,
      lockoutUntil: null,
      facts: null,
    });
    const accounts = two === null ? [ok(1)] : [ok(1), { ...ok(2), ...two }];
    return { answered: new Map([[BrokerKind.Topstep, { answer: { source: "website", accounts }, at }]]), failed: [], fallbacks: [] };
  }
  const DLL: Partial<AccountStateAnswer> = {
    state: "locked",
    cause: "daily-loss",
    lockoutReason: LOST,
    lockoutUntil: NEXT_OPEN,
  };
  const at = (minute: number) => new Date(T0.getTime() - 60 * 60_000 + minute * 60_000).toISOString();
  const changes = (events: ReturnType<typeof makeJob>["events"]) =>
    events.filter((e) => e.event === "account_state_changed");

  async function run(answers: AccountStatusFanOut[]) {
    const made = makeJob(answers);
    for (let i = 0; i < answers.length; i++) await made.job.check();
    return changes(made.events);
  }

  it("says ok → locked once, naming the account, both states, the cause, its figures and the end", async () => {
    const lines = await run([topstepFan({}, at(0)), topstepFan(DLL, at(1))]);
    expect(lines).toEqual([
      {
        event: "account_state_changed",
        message: `Account 2 went from ok to locked (${LOST}) until Wed, Oct 14, 6:00 PM ET.`,
        subject: { accountId: 2 },
      },
    ]);
  });

  // The hourly and after-close checks rewrite the same lock with fresh figures.
  it("says nothing for an unchanged state, however many checks rewrite it", async () => {
    const again = { ...DLL, lockoutReason: dailyLossLockReason(120_000, 100_000) };
    const lines = await run([topstepFan({}, at(0)), topstepFan(DLL, at(1)), topstepFan(again, at(2)), topstepFan(DLL, at(3))]);
    expect(lines).toHaveLength(1);
  });

  it("says a cause change on a lock that stays locked", async () => {
    const cannot: Partial<AccountStateAnswer> = { state: "locked", cause: "cannot-trade", lockoutReason: CANNOT_TRADE_LOCK_REASON };
    const lines = await run([topstepFan(cannot, at(0)), topstepFan(DLL, at(1))]);
    expect(lines.map((l) => l.message)).toEqual([
      `Account 2 went from never checked to locked (${CANNOT_TRADE_LOCK_REASON}), with no end time given.`,
      `Account 2 went from locked (Topstep's account list says it cannot trade) to locked (${LOST}) until Wed, Oct 14, 6:00 PM ET.`,
    ]);
  });

  it("says the unlock when a check writes ok over the lock", async () => {
    const lines = await run([topstepFan({}, at(0)), topstepFan(DLL, at(1)), topstepFan({}, at(2))]);
    expect(lines.at(-1)?.message).toBe("Account 2 went from locked (daily loss limit) to ok.");
  });

  it("says a move to dead, with the breach's figures when it is a maximum-loss one", async () => {
    const breach = maxLossReason(4_799_999, 4_800_000);
    const lines = await run([
      topstepFan({}, at(0)),
      topstepFan({ state: "dead", cause: "max-loss", lockoutReason: breach }, at(1)),
    ]);
    expect(lines.map((l) => l.message)).toEqual([`Account 2 went from ok to dead (${breach}).`]);
  });

  it("says an account its broker stopped listing went dead", async () => {
    const lines = await run([topstepFan({}, at(0)), topstepFan(null, at(1))]);
    expect(lines.map((l) => l.message)).toEqual(["Account 2 went from ok to dead."]);
  });

  // A boot's first check would otherwise name every account in the catalogue.
  it("says nothing for a never-checked account that reads ok", async () => {
    expect(await run([topstepFan({}, at(0))])).toEqual([]);
  });

  // A row stored before causes were (or by a fallback that could not tell)
  // getting its cause is not a change of state.
  it("says nothing when only a missing cause is filled in under the same state", async () => {
    const lines = await run([
      topstepFan({ ...DLL, cause: null }, at(0)),
      topstepFan(DLL, at(1)),
      topstepFan({ state: "dead", cause: null }, at(2)),
      topstepFan({ state: "dead", cause: "website" }, at(3)),
    ]);
    expect(lines.map((l) => l.message)).toEqual([
      `Account 2 went from never checked to locked (${LOST}) until Wed, Oct 14, 6:00 PM ET.`,
      "Account 2 went from locked (daily loss limit) to dead.",
    ]);
    expect(getAccountDeployState(2)?.cause).toBe("website");
  });

  it("never moves a stored max-loss back to website while the account stays dead, nor says it", async () => {
    const breach = maxLossReason(4_799_999, 4_800_000);
    const made = makeJob([
      topstepFan({ state: "dead", cause: "max-loss", lockoutReason: breach }, at(0)),
      topstepFan({ state: "dead", cause: "website" }, at(1)),
    ]);
    await made.job.check();
    await made.job.check();
    expect(getAccountDeployState(2)).toMatchObject({ status: "dead", cause: "max-loss", lockoutReason: breach });
    expect(changes(made.events)).toHaveLength(1);
  });

  // Halt and weekend: the answer cannot say whether the lock still holds.
  it("holds a stored lock through an answer marked holdStoredLock, writing the facts and saying nothing", async () => {
    const facts: BrokerAccountFacts = {
      autoOcoBrackets: false,
      bracketAutoApply: null,
      bracketAmountToRiskUsd: null,
      bracketAmountToMakeUsd: null,
      startingBalanceUsd: 50_000,
      maximumLossUsd: 48_000,
      highestBalanceUsd: 50_000,
      startOfDayBalanceUsd: 51_713.79,
      dailyLossUsd: 1_000,
      personalDailyLossLimitUsd: null,
      personalDailyProfitTargetUsd: null,
      stage: 1,
      templateId: 67,
    };
    const made = makeJob([topstepFan(DLL, at(0)), topstepFan({ holdStoredLock: true, facts }, at(1))]);
    await made.job.check();
    await made.job.check();
    expect(getAccountDeployState(2)).toMatchObject({
      status: "locked",
      cause: "daily-loss",
      lockoutReason: LOST,
      lockoutUntil: NEXT_OPEN,
      autoOcoBrackets: false,
    });
    expect(changes(made.events)).toHaveLength(1);
  });

  it("does not hold an ok: a hold over a stored ok writes ok and says nothing", async () => {
    const lines = await run([topstepFan({}, at(0)), topstepFan({ holdStoredLock: true }, at(1))]);
    expect(lines).toEqual([]);
    expect(getAccountDeployState(2)?.status).toBe("ok");
  });

  it("says nothing for a search fallback that keeps a running lock whole", async () => {
    const made = makeJob([
      topstepFan(DLL, at(0)),
      {
        answered: new Map([[BrokerKind.Topstep, { answer: accountStatesFromSearch([1, 2], []), at: at(1) }]]),
        failed: [],
        fallbacks: [],
      },
    ]);
    await made.job.check();
    await made.job.check();
    expect(changes(made.events)).toHaveLength(1);
  });
});
