/**
 * The close sampler — when it writes, and every way it declines to.
 *
 * The one thing it produces is the number tomorrow's per-trade budget is
 * divided by, so what has to hold is not "it eventually samples" but the four
 * refusals: no live session, nothing unsampled, a broker that did not answer,
 * and a balance that is not a number. Each of them leaves the account on the
 * lowest budget of its phase, which is the fail-closed direction.
 *
 * The db seam is mocked and everything else is real — `currentCmeSessionStart`
 * decides the gap, so the instants below are pinned wall-clock rather than
 * stubbed answers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

// `BrokerKind` is a string const enum that does not inline under this
// transpiler (patterns.md), so the mock supplies the values the sampler
// compares against.
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  listAccountRiskPostures: vi.fn().mockReturnValue([]),
  recordSessionClose: vi.fn().mockReturnValue(true),
}));

import {
  SessionCloseSampler,
  SESSION_CLOSE_SAMPLER_INTERVAL_MS,
  SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS,
  type AccountBalanceFanOut,
  type SessionCloseSamplerDeps,
} from "./engine-session-close";
import {
  BrokerKind,
  listAccountRiskPostures,
  recordSessionClose,
} from "@/lib/db/account-brokers";
import { resetLogBursts } from "@/lib/logging/pipe";
import type { AccountRiskPhase } from "@/lib/trading/orders/account-phase-sizer";

/** Friday 17:30 ET — inside the weekend gap, so `currentCmeSessionStart`
 *  answers Sunday's open and that answer is still in the future. */
const IN_THE_GAP = new Date("2026-09-04T21:30:00.000Z");
/** Friday 11:00 ET — inside a live session, whose open is in the past. */
const IN_A_SESSION = new Date("2026-09-04T15:00:00.000Z");
/** The session Friday's close sizes: Sunday 18:00 ET. */
const NEXT_OPEN = "2026-09-06T22:00:00.000Z";
/** Monday 17:30 ET — the next gap after the weekend one, sizing Monday's
 *  18:00 ET open. */
const NEXT_GAP = new Date("2026-09-07T21:30:00.000Z");
/** Thursday 17:59:50 ET — ten seconds of gap left before the nightly open. */
const TEN_SECONDS_BEFORE_OPEN = new Date("2026-09-03T21:59:50.000Z");
/** Six seconds after that same open, which is now trading. */
const JUST_AFTER_OPEN = new Date("2026-09-03T22:00:06.000Z");

const COMBINE_ACCOUNT = 90063379;
const FUNDED_ACCOUNT = 23463380;

type AccountRow = ReturnType<typeof listAccountRiskPostures>[number];

function accountRow(
  accountId: number,
  over: {
    broker?: BrokerKind;
    phase?: AccountRiskPhase;
    sizesSessionStart?: string | null;
  } = {},
): AccountRow {
  return {
    accountId,
    name: `50KTC-${accountId}`,
    broker: over.broker ?? BrokerKind.Topstep,
    practice: false,
    posture: { maxRiskPerTradeUsd: 500, maxContracts: 3 },
    dailyPnl: { dailyMaxLossUsd: 0, dailyMaxProfitUsd: 0, dailyPnlIncludeUnrealized: false },
    riskPhase: {
      broker: (over.broker ?? BrokerKind.Topstep) === BrokerKind.Tradovate ? "tradovate" : "topstep",
      phase: over.phase ?? "combine",
      mllUsd: 2_000,
      startBalanceUsd: 50_000,
      pressAtUsd: null,
      payoutTakenAt: null,
    },
    eodSample: {
      balanceUsd: null,
      peakUsd: null,
      sizesSessionStart: over.sizesSessionStart ?? null,
      recordedAt: null,
    },
    status: {
      state: null,
      checkedAt: null,
      source: null,
      statusCode: null,
      lockoutReason: null,
      lockoutUntil: null,
    },
    brokerFacts: null,
  };
}

function makeSampler(balances: Array<[number, number]>, failed: BrokerKind[] = []) {
  const events: Array<{ event: string; message: string }> = [];
  const fanOut: AccountBalanceFanOut = {
    balances: new Map(balances),
    failedBrokers: new Set(failed),
  };
  const refreshAccountBalances = vi.fn().mockResolvedValue(fanOut);
  const deps = {
    refreshAccountBalances,
    logEvent: (event: string, _deploymentId: string, message: string) =>
      void events.push({ event, message }),
    engineScope: "engine",
  } satisfies SessionCloseSamplerDeps;
  return { sampler: new SessionCloseSampler(deps), events, refreshAccountBalances, fanOut };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(IN_THE_GAP);
  resetLogBursts();
  vi.mocked(recordSessionClose).mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionCloseSampler", () => {
  it("records one close per phased account, stamped with the session it sizes", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([
      accountRow(COMBINE_ACCOUNT),
      accountRow(FUNDED_ACCOUNT, { phase: "funded_fresh" }),
    ]);
    const { sampler } = makeSampler([
      [COMBINE_ACCOUNT, 51_480.25],
      [FUNDED_ACCOUNT, 1_240],
    ]);

    await sampler.runSessionCloseSampler(IN_THE_GAP);

    expect(recordSessionClose).toHaveBeenCalledTimes(2);
    expect(recordSessionClose).toHaveBeenCalledWith(COMBINE_ACCOUNT, {
      balance: 51_480.25,
      sessionStart: NEXT_OPEN,
      now: IN_THE_GAP,
    });
    expect(recordSessionClose).toHaveBeenCalledWith(FUNDED_ACCOUNT, {
      balance: 1_240,
      sessionStart: NEXT_OPEN,
      now: IN_THE_GAP,
    });
  });

  // The sample is what makes the pass idempotent — not a flag on the sampler —
  // so a restart mid-gap is the same as a second pass.
  it("writes nothing on a second pass in the same gap, and does not fan out again", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([
      accountRow(COMBINE_ACCOUNT, { sizesSessionStart: NEXT_OPEN }),
    ]);
    const { sampler, refreshAccountBalances } = makeSampler([[COMBINE_ACCOUNT, 51_480.25]]);

    await sampler.runSessionCloseSampler(new Date(IN_THE_GAP.getTime() + 300_000));

    expect(refreshAccountBalances).not.toHaveBeenCalled();
    expect(recordSessionClose).not.toHaveBeenCalled();
  });

  // The whole gap test is "the start it returned is in the future". Asserting
  // the fan-out is what makes this about the gate rather than about the write:
  // a balance read inside a live session could already carry a fill.
  it("writes nothing inside a live session, and asks no broker", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, refreshAccountBalances } = makeSampler([[COMBINE_ACCOUNT, 51_480.25]]);

    await sampler.runSessionCloseSampler(IN_A_SESSION);

    expect(refreshAccountBalances).not.toHaveBeenCalled();
    expect(recordSessionClose).not.toHaveBeenCalled();
  });

  // The clock the write is stamped with is the one the fan-out returned on, not
  // the one the pass opened on. A pass that starts ten seconds before the open
  // and returns six seconds after it read a balance that may already carry the
  // new session's first fill — the intraday posture nobody measured.
  it("writes nothing when the fan-out returns after the session has opened", async () => {
    vi.setSystemTime(TEN_SECONDS_BEFORE_OPEN);
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, refreshAccountBalances, fanOut } = makeSampler([
      [COMBINE_ACCOUNT, 51_480.25],
    ]);
    refreshAccountBalances.mockImplementation(async () => {
      vi.setSystemTime(JUST_AFTER_OPEN);
      return fanOut;
    });

    await sampler.runSessionCloseSampler(TEN_SECONDS_BEFORE_OPEN);

    expect(refreshAccountBalances).toHaveBeenCalledTimes(1);
    expect(recordSessionClose).not.toHaveBeenCalled();
  });

  it("writes nothing for an account whose balance is not a number, and says so once", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, events } = makeSampler([[COMBINE_ACCOUNT, Number.NaN]]);

    await sampler.runSessionCloseSampler(IN_THE_GAP);
    await sampler.runSessionCloseSampler(new Date(IN_THE_GAP.getTime() + 300_000));

    expect(recordSessionClose).not.toHaveBeenCalled();
    expect(events.filter((e) => e.event === "session_close_unsampled")).toHaveLength(1);
  });

  it("writes nothing for an account the fan-out did not report at all", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, events } = makeSampler([]);

    await sampler.runSessionCloseSampler(IN_THE_GAP);

    expect(recordSessionClose).not.toHaveBeenCalled();
    expect(events.map((e) => e.event)).toEqual(["session_close_unsampled"]);
  });

  // A broker that threw reported nothing, which is not evidence about its
  // accounts. The fan-out's own failure has its own voice, so this arm is
  // silent rather than a warn per account per pass for the whole weekend.
  it("writes nothing and says nothing for a broker whose arm failed", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, events } = makeSampler([], [BrokerKind.Topstep]);

    await sampler.runSessionCloseSampler(IN_THE_GAP);

    expect(recordSessionClose).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  // An account the arm never answers for stays unsampled for the whole gap, so
  // the stamp cannot make the pass idempotent and the retry would otherwise run
  // a full fan-out — registry refresh, adapter sync, refresh-failure alert —
  // every five minutes until Sunday.
  it("gives up on a gap after its attempt bound, and starts over in the next one", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, refreshAccountBalances } = makeSampler([], [BrokerKind.Topstep]);

    for (let pass = 0; pass <= SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS; pass++) {
      const at = new Date(IN_THE_GAP.getTime() + pass * SESSION_CLOSE_SAMPLER_INTERVAL_MS);
      vi.setSystemTime(at);
      await sampler.runSessionCloseSampler(at);
    }
    expect(refreshAccountBalances).toHaveBeenCalledTimes(SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS);

    vi.setSystemTime(NEXT_GAP);
    await sampler.runSessionCloseSampler(NEXT_GAP);
    expect(refreshAccountBalances).toHaveBeenCalledTimes(SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS + 1);
  });

  // What `stop()` calls. The warn anchor survives a stop and this does not:
  // one keeps a restart from re-saying a line, the other bounds a loop nobody
  // is watching, and a restart is somebody watching.
  it("hands the gap another set of attempts after resetAttempts", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([accountRow(COMBINE_ACCOUNT)]);
    const { sampler, refreshAccountBalances } = makeSampler([], [BrokerKind.Topstep]);

    for (let pass = 0; pass <= SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS; pass++) {
      await sampler.runSessionCloseSampler(IN_THE_GAP);
    }
    sampler.resetAttempts();
    await sampler.runSessionCloseSampler(IN_THE_GAP);

    expect(refreshAccountBalances).toHaveBeenCalledTimes(SESSION_CLOSE_SAMPLER_MAX_ATTEMPTS + 1);
  });

  it("ignores accounts with no phase and phases on a non-Topstep row", async () => {
    vi.mocked(listAccountRiskPostures).mockReturnValue([
      accountRow(COMBINE_ACCOUNT, { phase: "off" }),
      accountRow(FUNDED_ACCOUNT, { broker: BrokerKind.Tradovate, phase: "funded_paid" }),
    ]);
    const { sampler, refreshAccountBalances } = makeSampler([
      [COMBINE_ACCOUNT, 51_480.25],
      [FUNDED_ACCOUNT, 1_240],
    ]);

    await sampler.runSessionCloseSampler(IN_THE_GAP);

    expect(refreshAccountBalances).not.toHaveBeenCalled();
    expect(recordSessionClose).not.toHaveBeenCalled();
  });
});
