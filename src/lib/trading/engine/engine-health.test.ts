/**
 * Per-seam health and degraded mode (D-8, D-10, D-15).
 *
 * Two properties carry most of the value here and both are easy to break by
 * accident:
 *
 * 1. **Only `down` changes behaviour.** `stale` is advisory. A test that lets
 *    `stale` reach `mayEnterOnBar` would let a quiet contract stop trading.
 * 2. **The broker arm is reported, never enforced.** Blocking evaluation on
 *    `orders: down` stops the calls whose success clears it, and the
 *    deployment never recovers. There is an explicit test for that below,
 *    because the "obvious" implementation is the broken one.
 *
 * **Nothing here tests a `down` gate, because there is no reachable one.**
 * `fetchBars` throws while the feed is down and `processDeployment` reads
 * bars before anything else, so the throw is what enforces `down` and this
 * controller is never asked. The two tests that used to claim otherwise
 * stubbed the engine's `fetchBars` wrapper to reach a gate the running system
 * cannot reach — an assertion against an impossible state. Their honest
 * replacements drive a real bar-read failure and live in
 * `engine.lastBarTimestamp.test.ts`, beside the ordering they depend on.
 *
 * Thresholds are imported from the hub rather than restated, so a change to
 * the ladder moves these tests with it instead of silently disagreeing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("../strategies", () => ({
  getStrategy: vi.fn(),
}));

import type { Deployment } from "@/lib/trading/domain";
import { BrokerKind } from "@/lib/db/account-brokers";
import { EVENTS, deriveLegacyLevel, type LegacyLevel } from "@/lib/logging/vocabulary";
import { getStrategy } from "../strategies";
import {
  HEARTBEAT_TRADE_SILENCE_WARN_S,
  MARKET_HUB_STALL_MS,
} from "./engine-market-hub";
import {
  EngineHealth,
  FROZEN_AWAITING_ENTRY_BAR,
  FROZEN_WHILE_ENTRIES_SUSPENDED,
  FROZEN_WHILE_FEED_DOWN,
  anyDeploymentInSession,
  deriveMarketDataState,
  isFeedDown,
  type HealthDeps,
  type MarketDataContext,
  type MarketDataObservations,
} from "./engine-health";

/** 2026-08-24 is a Monday. 14:30 UTC = 10:30 ET, inside a 09:30–16:00 window. */
const IN_WINDOW = new Date("2026-08-24T14:30:00.000Z");
/** 21:30 UTC = 17:30 ET, outside both a 09:30–16:00 and an 18:00–04:00 window. */
const OUT_OF_WINDOW = new Date("2026-08-24T21:30:00.000Z");
/** 23:30 UTC = 19:30 ET — outside the day session, inside an overnight one. */
const OVERNIGHT_ONLY = new Date("2026-08-24T23:30:00.000Z");

/** Every controller test runs at an instant that is in session, so the stale
 *  arm is reachable without restating the session gate in each one. */
const T0 = IN_WINDOW.getTime();
const SILENCE_MS = HEARTBEAT_TRADE_SILENCE_WARN_S * 1000;
/** The one account the default harness manages. The order seam is keyed per
 *  account, so every `noteBrokerOrders` call names one. */
const ACCT = 4242;

function obs(over: Partial<MarketDataObservations> = {}): MarketDataObservations {
  return { barFailingSince: null, lastBarError: null, ...over };
}

function ctx(over: Partial<MarketDataContext> = {}): MarketDataContext {
  return {
    now: T0,
    lastFeedTickAt: T0,
    subscribedContracts: 2,
    inSessionWindow: true,
    inMaintenanceWindow: false,
    ...over,
  };
}

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: "deploy-aaa",
    accountId: 4242,
    ticker: "MNQ",
    strategyKey: "test-strategy",
    paramValues: { pauseWindows: [] },
    status: "Active",
    contractId: "CON.F.US.MNQ.M26",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: null,
    enabledSnapshot: null,
    ...over,
  } as Deployment;
}

interface Harness {
  health: EngineHealth;
  log: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
  alertDegraded: ReturnType<typeof vi.fn>;
  setFeedTickAt: (at: number) => void;
  setSubscribed: (n: number) => void;
  setEntriesSuspended: (suspended: boolean) => void;
}

function makeHealth(over: Partial<HealthDeps> = {}): Harness {
  const log = vi.fn();
  const logEvent = vi.fn();
  const alertDegraded = vi.fn();
  let feedTickAt = T0;
  let subscribed = 2;
  let entriesSuspended = false;

  const deps: HealthDeps = {
    log,
    logEvent,
    lastFeedTickAt: () => feedTickAt,
    subscribedContracts: () => subscribed,
    inSessionWindow: () => true,
    managedAccounts: () => new Map([[BrokerKind.Topstep, new Set([ACCT])]]),
    realtimeHealthy: () => true,
    entriesSuspended: () => entriesSuspended,
    alertDegraded,
    ...over,
  };

  return {
    health: new EngineHealth(deps),
    log,
    logEvent,
    alertDegraded,
    setFeedTickAt: (at) => { feedTickAt = at; },
    setSubscribed: (n) => { subscribed = n; },
    setEntriesSuspended: (suspended) => { entriesSuspended = suspended; },
  };
}

/**
 * `[deploymentId, chip, message]` for every line the health controller
 * logged.
 *
 * The chip is **derived** from the event's registered pair rather than
 * asserted here, so these assertions also pin that a feed line still lands
 * under the chip it landed under before the migration: `feed_down` under
 * ERROR, the unannounced restore under WARN, the announced one under
 * CONNECTION.
 */
function lines(h: Harness): Array<[string, LegacyLevel, string]> {
  return h.logEvent.mock.calls.map((c) => {
    const event = String(c[0]);
    const spec = EVENTS[event];
    return [String(c[1]), deriveLegacyLevel(spec.severity, spec.category, event), String(c[2])];
  });
}

/** Drive the slot to `down` and return the instant it got there. */
function driveDown(h: Harness): number {
  h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, T0);
  const downAt = T0 + MARKET_HUB_STALL_MS;
  h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, downAt);
  return downAt;
}

// ── The ladder ───────────────────────────────────────────────────────

describe("deriveMarketDataState — the three states", () => {
  it("is healthy when nothing has failed and the feed is ticking", () => {
    expect(deriveMarketDataState(obs(), ctx()).state).toBe("healthy");
  });

  it("stays healthy while a failing run is younger than the stall threshold", () => {
    const start = T0 - MARKET_HUB_STALL_MS + 1;
    expect(deriveMarketDataState(obs({ barFailingSince: start }), ctx()).state).toBe("healthy");
  });

  it("is down once the failing run reaches the stall threshold", () => {
    const start = T0 - MARKET_HUB_STALL_MS;
    const result = deriveMarketDataState(obs({ barFailingSince: start }), ctx());
    expect(result.state).toBe("down");
    expect(result.reason).toContain("bar reads failing");
  });

  it("carries the provider's own error into the reason", () => {
    const start = T0 - MARKET_HUB_STALL_MS;
    const result = deriveMarketDataState(
      obs({ barFailingSince: start, lastBarError: "429 rate limited" }),
      ctx(),
    );
    expect(result.reason).toContain("429 rate limited");
  });

  it("reports down over stale — a dead bar path outranks silence", () => {
    const start = T0 - MARKET_HUB_STALL_MS;
    const result = deriveMarketDataState(
      obs({ barFailingSince: start }),
      ctx({ lastFeedTickAt: T0 - SILENCE_MS }),
    );
    expect(result.state).toBe("down");
  });
});

describe("deriveMarketDataState — stale is global and session-gated", () => {
  it("is stale when nothing has ticked on ANY subscribed contract, in session", () => {
    const result = deriveMarketDataState(obs(), ctx({ lastFeedTickAt: T0 - SILENCE_MS }));
    expect(result.state).toBe("stale");
    expect(result.reason).toContain("2 subscribed contract(s)");
  });

  it("is healthy while any contract is still ticking — the anchor is global", () => {
    // The hub stamps one anchor for every inbound trade on every contract, so
    // MGC going quiet while MNQ prints leaves the feed healthy. This is D-15
    // point 3: per-contract silence must never gate evaluation on its own.
    const result = deriveMarketDataState(obs(), ctx({ lastFeedTickAt: T0 - SILENCE_MS + 1 }));
    expect(result.state).toBe("healthy");
  });

  it("does NOT read silence as stale outside every session window", () => {
    // The 120s stall threshold is justified by "RTH ticks arrive multiple
    // times per second" — true in session, false at 03:00, where silence is
    // correct. D-15 point 2.
    const result = deriveMarketDataState(
      obs(),
      ctx({ lastFeedTickAt: T0 - SILENCE_MS * 10, inSessionWindow: false }),
    );
    expect(result.state).toBe("healthy");
  });

  it("does NOT read silence as stale during the CME maintenance break", () => {
    const result = deriveMarketDataState(
      obs(),
      ctx({ lastFeedTickAt: T0 - SILENCE_MS * 10, inMaintenanceWindow: true }),
    );
    expect(result.state).toBe("healthy");
  });

  it("does NOT read silence as stale when no contract is subscribed", () => {
    const result = deriveMarketDataState(
      obs(),
      ctx({ lastFeedTickAt: T0 - SILENCE_MS * 10, subscribedContracts: 0 }),
    );
    expect(result.state).toBe("healthy");
  });

  it("does NOT read a never-ticked feed as stale", () => {
    // Before the first trade of the process there is no silence to measure,
    // only an absence of evidence.
    const result = deriveMarketDataState(obs(), ctx({ lastFeedTickAt: 0 }));
    expect(result.state).toBe("healthy");
  });

  it("still reports down out of session — only the stale arm is gated", () => {
    const result = deriveMarketDataState(
      obs({ barFailingSince: T0 - MARKET_HUB_STALL_MS }),
      ctx({ inSessionWindow: false }),
    );
    expect(result.state).toBe("down");
  });
});

describe("isFeedDown — the cheap predicate the hot paths use", () => {
  it("is false with no failing run", () => {
    expect(isFeedDown(null, T0)).toBe(false);
  });

  it("agrees with the full ladder at the threshold boundary", () => {
    expect(isFeedDown(T0 - MARKET_HUB_STALL_MS + 1, T0)).toBe(false);
    expect(isFeedDown(T0 - MARKET_HUB_STALL_MS, T0)).toBe(true);
  });
});

// ── Bar-read bookkeeping ─────────────────────────────────────────────

describe("EngineHealth.noteBarRead", () => {
  it("treats an empty series as a successful read", () => {
    // The provider answered; it just had nothing for the window. Counting it
    // as a failure would report a closed market as an outage.
    const h = makeHealth();
    h.health.noteBarRead({ ok: true, newestBarOpenMs: null }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: null }, T0 + MARKET_HUB_STALL_MS * 2);
    expect(h.health.snapshot(T0 + MARKET_HUB_STALL_MS * 2).degraded).toBe(false);
  });

  it("records the newest bar's open time as lastBarAt", () => {
    const h = makeHealth();
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 - 60_000 }, T0);
    expect(h.health.marketData(T0).lastBarAt).toBe(T0 - 60_000);
  });

  it("leaves lastBarAt alone on an empty series rather than nulling it", () => {
    const h = makeHealth();
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 - 60_000 }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: null }, T0 + 1000);
    expect(h.health.marketData(T0 + 1000).lastBarAt).toBe(T0 - 60_000);
  });

  it("announces degraded mode exactly once when the run crosses the threshold", () => {
    const h = makeHealth();
    driveDown(h);
    expect(h.alertDegraded).toHaveBeenCalledTimes(1);
    expect(h.alertDegraded).toHaveBeenCalledWith(true, expect.stringContaining("DOWN"));
    const errors = lines(h).filter(([, chip]) => chip === "error");
    expect(errors).toHaveLength(1);
  });

  it("names break-even and trailing in the degraded announcement", () => {
    // D-10's operator requirement: these degrade silently, and a stop that has
    // stopped trailing looks identical to one still trailing.
    const h = makeHealth();
    driveDown(h);
    const message = String(lines(h).find(([, chip]) => chip === "error")?.[2]);
    expect(message).toContain("break-even");
    expect(message).toContain("trailing");
  });

  it("states that open positions are still monitored", () => {
    const h = makeHealth();
    driveDown(h);
    const message = String(lines(h).find(([, chip]) => chip === "error")?.[2]);
    expect(message).toContain("session-end");
    expect(message).toContain("watchdog");
  });

  it("does not re-announce on every failing read while already down", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "still 503" }, downAt + 15_000);
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "still 503" }, downAt + 30_000);
    expect(h.alertDegraded).toHaveBeenCalledTimes(1);
  });

  it("announces recovery once, and only after having been down", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, downAt + 60_000);
    expect(h.alertDegraded).toHaveBeenCalledTimes(2);
    expect(h.alertDegraded).toHaveBeenLastCalledWith(false, expect.stringContaining("RESTORED"));
  });

  it("does not announce anything on a first successful read", () => {
    const h = makeHealth();
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0);
    expect(h.alertDegraded).not.toHaveBeenCalled();
  });

  it("does not announce a failing run that recovers before the threshold", () => {
    const h = makeHealth();
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "blip" }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0 + MARKET_HUB_STALL_MS - 1);
    expect(h.alertDegraded).not.toHaveBeenCalled();
  });

  it("emits no log line for stale — the heartbeat already carries that warn", () => {
    const h = makeHealth();
    h.setFeedTickAt(T0 - SILENCE_MS * 5);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0);
    expect(h.log).not.toHaveBeenCalled();
  });
});

// ── The post-outage entry gate ───────────────────────────────────────

describe("EngineHealth.mayEnterOnBar", () => {
  it("allows an entry on a healthy feed", () => {
    const h = makeHealth();
    expect(h.health.mayEnterOnBar(T0).allowed).toBe(true);
  });

  it("allows an entry while the feed is DOWN, because the bar read is what refuses", () => {
    // Not a weakening: `fetchBars` throws while the feed is down and
    // `processDeployment` reads bars first, so this method is unreachable in
    // that state. A `down` arm here would be code only a test could exercise,
    // and the two tests that used to exercise it stubbed the wrapper to do so.
    const h = makeHealth();
    const downAt = driveDown(h);
    expect(h.health.marketData(downAt).state).toBe("down");
    expect(h.health.mayEnterOnBar(downAt).allowed).toBe(true);
  });

  it("does NOT refuse an entry while the feed is merely stale", () => {
    // Acting on `stale` is how a quiet contract produces a spurious flatten.
    // Two behavioural states, one advisory.
    const h = makeHealth();
    h.setFeedTickAt(T0 - SILENCE_MS * 5);
    expect(h.health.marketData(T0).state).toBe("stale");
    expect(h.health.mayEnterOnBar(T0).allowed).toBe(true);
  });

  it("refuses an entry on a bar that opened before the feed recovered", () => {
    // A bar forming across the outage is a setup whose formation nobody
    // watched — D-14's discard-the-trigger rule, against a bar.
    const h = makeHealth();
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);

    const gate = h.health.mayEnterOnBar(recoveredAt - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("postdates the outage");
  });

  it("allows the first bar that opens at or after the recovery instant", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);

    expect(h.health.mayEnterOnBar(recoveredAt).allowed).toBe(true);
  });

  it("arms the anchor when the whole outage falls between two reads", () => {
    // The read cadence is the shortest active timeframe — `fetchBars` runs
    // from `processDeployment`, which in realtime mode runs at bar close — so
    // a 180s outage on a 3m deployment produces exactly two reads: one
    // failure at the start, one success at the end, and nothing in between.
    // Arming off an *announced* DOWN armed nothing here, because nothing was
    // announced: the crossing at +120s had no read to observe it. Every
    // timeframe from 3m up was unprotected, and since the gate narrowed to
    // entries this anchor is the only post-outage protection there is.
    const h = makeHealth();
    const THREE_MIN = 180_000;
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 + 120_000 }, T0 + THREE_MIN);

    const gate = h.health.mayEnterOnBar(T0 + THREE_MIN - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("postdates the outage");
    expect(h.health.mayEnterOnBar(T0 + THREE_MIN).allowed).toBe(true);
  });

  it("does not arm the anchor when the run never crossed the threshold", () => {
    // The other half of the same rule: a blip that healed inside 120s is not
    // an outage, and holding entries back for it would refuse a bar on every
    // transient 503.
    const h = makeHealth();
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "blip" }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0 + MARKET_HUB_STALL_MS - 1);
    expect(h.health.mayEnterOnBar(T0 - 60_000).allowed).toBe(true);
  });

  it("moves the resume anchor forward on a second outage", () => {
    const h = makeHealth();
    const firstDown = driveDown(h);
    const firstRecovery = firstDown + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: firstDown }, firstRecovery);

    const secondFailStart = firstRecovery + 1000;
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "again" }, secondFailStart);
    const secondDown = secondFailStart + MARKET_HUB_STALL_MS;
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "again" }, secondDown);
    const secondRecovery = secondDown + 1000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: secondDown }, secondRecovery);

    // A bar that would have cleared the *first* anchor must not clear this one.
    expect(h.health.mayEnterOnBar(firstRecovery).allowed).toBe(false);
    expect(h.health.mayEnterOnBar(secondRecovery).allowed).toBe(true);
  });
});

describe("EngineHealth.noteEngineStarted — the second writer of the entry anchor", () => {
  /** Drive an outage that recovers at `recoveredAt`. */
  function recoverAt(h: Harness, recoveredAt: number): void {
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, recoveredAt - MARKET_HUB_STALL_MS - 1_000);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: recoveredAt - 60_000 }, recoveredAt);
  }

  it("refuses an entry on a bar that opened before the start, and says the engine started", () => {
    const h = makeHealth();
    h.health.noteEngineStarted(T0);

    const gate = h.health.mayEnterOnBar(T0 - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("before the engine started at");
    expect(gate.reason).not.toContain("feed");
    expect(h.health.mayEnterOnBar(T0).allowed).toBe(true);
  });

  it("holds to a feed recovery that comes after the start, and says the feed recovered", () => {
    const h = makeHealth();
    h.health.noteEngineStarted(T0);
    const recoveredAt = T0 + 600_000;
    recoverAt(h, recoveredAt);

    const gate = h.health.mayEnterOnBar(recoveredAt - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("postdates the outage");
    expect(h.health.marketData(recoveredAt).resumeFromBarOpenMs).toBe(recoveredAt);
  });

  it("holds to a start that comes after a feed recovery, and says the engine started", () => {
    const h = makeHealth();
    const recoveredAt = T0;
    recoverAt(h, recoveredAt);
    const startedAt = T0 + 600_000;
    h.health.noteEngineStarted(startedAt);

    const gate = h.health.mayEnterOnBar(startedAt - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("before the engine started at");
  });

  it("never moves the anchor back, whichever writer is earlier", () => {
    const h = makeHealth();
    const recoveredAt = T0 + 600_000;
    recoverAt(h, recoveredAt);
    h.health.noteEngineStarted(T0);

    expect(h.health.marketData(recoveredAt).resumeFromBarOpenMs).toBe(recoveredAt);
    expect(h.health.mayEnterOnBar(T0 + 1).allowed).toBe(false);
    expect(h.health.mayEnterOnBar(T0 + 1).reason).toContain("postdates the outage");
  });

  it("holds again after a reset, which is what an in-process stop → start does", () => {
    const h = makeHealth();
    h.health.noteEngineStarted(T0);
    h.health.reset();
    const restartedAt = T0 + 60_000;
    h.health.noteEngineStarted(restartedAt);

    expect(h.health.mayEnterOnBar(restartedAt - 1).allowed).toBe(false);
    expect(h.health.mayEnterOnBar(restartedAt).allowed).toBe(true);
  });

  it("reports the hold as a start hold, and clears it on the first bar that opened after the start", () => {
    const h = makeHealth();
    h.health.noteEngineStarted(T0);

    expect(h.health.snapshot(T0).entriesHeld).toBe("post-start-bar");
    expect(h.health.snapshot(T0).frozen).toEqual(FROZEN_AWAITING_ENTRY_BAR);
    const described = h.health.describeDeployment(BrokerKind.Topstep, T0);
    expect(described.canEnter).toBe(false);
    expect(described.reason).toContain("forming before the engine started");

    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0 + 300_000);
    expect(h.health.snapshot(T0 + 300_000).entriesHeld).toBeNull();
  });
});

describe("EngineHealth — the recovery announcement", () => {
  it("tells the operator that exits, break-even and trailing resume immediately", () => {
    // The operator-facing half of the entries-only narrowing. A message that
    // says "everything resumes once a bar postdating the outage closes" is
    // what the whole-tier gate promised, and it is a promise that froze
    // position management for up to two bar intervals on a healthy feed.
    const h = makeHealth();
    const downAt = driveDown(h);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, downAt + 60_000);

    const message = String(lines(h).find(([, chip]) => chip === "connection")?.[2]);
    expect(message).toContain("resume immediately");
    expect(message).toContain("break-even");
    expect(message).toContain("trailing");
    expect(message).toMatch(/Entries wait/);
  });

  it("says so when the outage ended before it could be announced", () => {
    // Arming off the *run* rather than off the announcement means a run
    // nobody was told about can now emit a restore. The choice is one line
    // that reads correctly rather than a retroactive DOWN: `alertDegraded`'s
    // entering arm announces *entering* degraded mode, which is already false
    // by the time it is read, and a DOWN/RESTORED pair one second apart
    // teaches the operator to skim past both.
    const h = makeHealth();
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0 + 180_000);

    expect(h.alertDegraded).toHaveBeenCalledTimes(1);
    expect(h.alertDegraded).toHaveBeenCalledWith(
      false,
      expect.stringContaining("before it could be announced"),
    );
    // No retroactive DOWN, on either channel.
    expect(h.alertDegraded).not.toHaveBeenCalledWith(true, expect.anything());
    expect(lines(h).filter(([, chip]) => chip === "error")).toHaveLength(0);
  });

  it("logs an unannounced outage at warn — that line is its only record", () => {
    const h = makeHealth();
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "provider 503" }, T0);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: T0 }, T0 + 180_000);

    const warns = lines(h).filter(([, chip]) => chip === "warn");
    expect(warns).toHaveLength(1);
    expect(String(warns[0][2])).toContain("180s of failing bar reads");
    // Not the announced wording: that one is a `connection` line and claims a
    // DOWN the operator was told about.
    expect(lines(h).filter(([, chip]) => chip === "connection")).toHaveLength(0);
  });

  it("keeps the announced wording when the DOWN was announced", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, downAt + 60_000);

    const connection = lines(h).filter(([, chip]) => chip === "connection");
    expect(connection).toHaveLength(1);
    expect(String(connection[0][2])).not.toContain("before it could be announced");
  });
});

describe("EngineHealth — the published downSince", () => {
  it("reports the instant the slot entered down, not the instant a read noticed", () => {
    // The crossing happens between two reads and the read that observes it
    // can be a whole timeframe late. `downSince` is documented as the instant
    // the slot entered `down`; stamping it at the observing read made it the
    // detection instant wearing that name.
    const h = makeHealth();
    const firstFailure = T0;
    const noticedAt = T0 + 300_000;
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "503" }, firstFailure);
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "503" }, noticedAt);

    expect(h.health.marketData(noticedAt).downSince).toBe(firstFailure + MARKET_HUB_STALL_MS);
  });

  it("is null while the slot is not down", () => {
    const h = makeHealth();
    h.health.noteBarRead({ ok: false, newestBarOpenMs: null, error: "503" }, T0);
    expect(h.health.marketData(T0 + 1000).downSince).toBeNull();
  });
});

// ── Broker seams ─────────────────────────────────────────────────────

describe("EngineHealth — broker seams", () => {
  it("reads a broker nothing has called as up, not down", () => {
    const h = makeHealth();
    expect(h.health.snapshot(T0).brokers[BrokerKind.Topstep].orders).toBe("up");
  });

  it("marks the order seam down after a failed broker call", () => {
    const h = makeHealth();
    h.health.noteBrokerOrders(ACCT, false, "connect ETIMEDOUT", T0);
    const seam = h.health.snapshot(T0).brokers[BrokerKind.Topstep];
    expect(seam.orders).toBe("down");
    expect(seam.ordersReason).toContain("ETIMEDOUT");
  });

  it("clears the order seam on the next success", () => {
    const h = makeHealth();
    h.health.noteBrokerOrders(ACCT, false, "connect ETIMEDOUT", T0);
    h.health.noteBrokerOrders(ACCT, true, null, T0 + 15_000);
    expect(h.health.snapshot(T0 + 15_000).brokers[BrokerKind.Topstep].orders).toBe("up");
  });

  it("keeps the first failure's anchor across repeated failures", () => {
    const h = makeHealth();
    h.health.noteBrokerOrders(ACCT, false, "first", T0);
    h.health.noteBrokerOrders(ACCT, false, "second", T0 + 60_000);
    const seam = h.health.snapshot(T0 + 60_000).brokers[BrokerKind.Topstep];
    expect(seam.ordersReason).toContain("second");
    expect(seam.ordersReason).toContain(new Date(T0).toISOString());
  });

  it("keeps one account's order seam up while a sibling account is failing", () => {
    // Same rule as the event seam below: one bad account is an account
    // problem, every bad account is the seam.
    const h = makeHealth({
      managedAccounts: () => new Map([[BrokerKind.Topstep, new Set([1, 2])]]),
    });
    h.health.noteBrokerOrders(1, false, "acct 1 ETIMEDOUT", T0);
    expect(h.health.snapshot(T0).brokers[BrokerKind.Topstep].orders).toBe("up");
  });

  it("does NOT let one account's success clear another account's failure", () => {
    // The whole reason the seam is keyed per account. It is fed per account
    // from both of the reconciler's fan-outs, so a per-broker key was
    // last-writer-wins: account 2 answering deleted account 1's evidence, and
    // account 1 could fail all day behind a healthy sibling.
    const h = makeHealth({
      managedAccounts: () => new Map([[BrokerKind.Topstep, new Set([1, 2])]]),
    });
    h.health.noteBrokerOrders(1, false, "acct 1 ETIMEDOUT", T0);
    h.health.noteBrokerOrders(2, true, null, T0 + 15_000);
    h.health.noteBrokerOrders(2, false, "acct 2 ETIMEDOUT", T0 + 30_000);

    const seam = h.health.snapshot(T0 + 30_000).brokers[BrokerKind.Topstep];
    expect(seam.orders).toBe("down");
    // Account 1's evidence survived account 2's success: the reported anchor
    // is the start of the broker-wide outage, not the last account to fail.
    expect(seam.ordersReason).toContain("account 1");
    expect(seam.ordersReason).toContain(new Date(T0).toISOString());
  });

  it("marks the event seam down only when every managed account is unhealthy", () => {
    const h = makeHealth({
      managedAccounts: () => new Map([[BrokerKind.Topstep, new Set([1, 2])]]),
      realtimeHealthy: (_kind, accountId) => accountId === 2,
    });
    expect(h.health.snapshot(T0).brokers[BrokerKind.Topstep].events).toBe("up");
  });

  it("marks the event seam down when no managed account has a healthy transport", () => {
    const h = makeHealth({ realtimeHealthy: () => false });
    const seam = h.health.snapshot(T0).brokers[BrokerKind.Topstep];
    expect(seam.events).toBe("down");
    expect(seam.eventsReason).toContain("no healthy realtime transport");
  });

  it("reports the two seams independently — one down does not drag the other", () => {
    const h = makeHealth({ realtimeHealthy: () => false });
    h.health.noteBrokerOrders(ACCT, true, null, T0);
    const seam = h.health.snapshot(T0).brokers[BrokerKind.Topstep];
    expect(seam.orders).toBe("up");
    expect(seam.events).toBe("down");
  });

  it("reports each broker separately — one broker down leaves the other up", () => {
    const h = makeHealth({
      managedAccounts: () =>
        new Map([
          [BrokerKind.Topstep, new Set([1])],
          [BrokerKind.Tradovate, new Set([2])],
        ]),
    });
    h.health.noteBrokerOrders(1, false, "topstep 500", T0);
    const snapshot = h.health.snapshot(T0);
    expect(snapshot.brokers[BrokerKind.Topstep].orders).toBe("down");
    expect(snapshot.brokers[BrokerKind.Tradovate].orders).toBe("up");
  });
});

// ── The derived per-deployment answer ────────────────────────────────

describe("EngineHealth.describeDeployment", () => {
  it("allows evaluation, entries and orders when every seam is up", () => {
    const h = makeHealth();
    const result = h.health.describeDeployment(BrokerKind.Topstep, T0);
    expect(result.canEvaluate).toBe(true);
    expect(result.canEnter).toBe(true);
    expect(result.canPlaceOrders).toBe(true);
    expect(result.frozen).toHaveLength(0);
  });

  it("stops evaluation and names the frozen work when the data slot is down", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    const result = h.health.describeDeployment(BrokerKind.Topstep, downAt);
    expect(result.canEvaluate).toBe(false);
    expect(result.canEnter).toBe(false);
    expect(result.frozen).toEqual(FROZEN_WHILE_FEED_DOWN);
  });

  it("reports entries as still frozen after recovery, while evaluation is not", () => {
    // The surface has to say this, because `mayEnterOnBar` is still refusing:
    // reporting an all-clear here tells the operator nothing is wrong while
    // every entry is being turned away. Evaluation genuinely has resumed —
    // exits, break-even and trailing ran on the recovering read's bar — so
    // the two values are separately true and are reported separately.
    const h = makeHealth();
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);

    const result = h.health.describeDeployment(BrokerKind.Topstep, recoveredAt);
    expect(result.canEvaluate).toBe(true);
    expect(result.canEnter).toBe(false);
    expect(result.frozen).toEqual(FROZEN_AWAITING_ENTRY_BAR);
    expect(result.reason).toContain("entries held until a bar opens at or after");
    // And the gate it is reporting agrees with it.
    expect(h.health.mayEnterOnBar(downAt).allowed).toBe(false);
  });

  it("clears the entry hold once a bar postdating the outage has been evaluated", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: recoveredAt }, recoveredAt + 60_000);

    const result = h.health.describeDeployment(BrokerKind.Topstep, recoveredAt + 60_000);
    expect(result.canEnter).toBe(true);
    expect(result.frozen).toHaveLength(0);
    expect(result.reason).toBeNull();
    expect(h.health.mayEnterOnBar(recoveredAt).allowed).toBe(true);
  });

  it("stops evaluation for a Tradovate deployment too — bars are one global slot", () => {
    // The whole reason the model is per-seam: a Topstep data outage stops
    // evaluation for every deployment, on every broker, while both brokers'
    // order paths keep working.
    const h = makeHealth({
      managedAccounts: () => new Map([[BrokerKind.Tradovate, new Set([7])]]),
    });
    const downAt = driveDown(h);
    const result = h.health.describeDeployment(BrokerKind.Tradovate, downAt);
    expect(result.canEvaluate).toBe(false);
    expect(result.canPlaceOrders).toBe(true);
  });

  it("REPORTS a down order seam without blocking evaluation", () => {
    // Blocking evaluation on `orders: down` would stop the very broker calls
    // whose success clears the seam — the deployment would never recover.
    // The seam's evidence only exists while there is something to reconcile,
    // so `up` means "nothing has failed lately" rather than "the broker
    // answers", and `down` is set only while the clearing work is running.
    const h = makeHealth();
    h.health.noteBrokerOrders(ACCT, false, "connect ETIMEDOUT", T0);
    const result = h.health.describeDeployment(BrokerKind.Topstep, T0);
    expect(result.canPlaceOrders).toBe(false);
    expect(result.canEvaluate).toBe(true);
    expect(result.canEnter).toBe(true);
  });

  it("does not stop evaluation for a broker that has no managed accounts", () => {
    const h = makeHealth({ managedAccounts: () => new Map() });
    const result = h.health.describeDeployment(BrokerKind.Topstep, T0);
    expect(result.canEvaluate).toBe(true);
    expect(result.canPlaceOrders).toBe(true);
  });

  it("reports the flap breaker, which is on no other surface at all", () => {
    const h = makeHealth();
    h.setEntriesSuspended(true);
    const result = h.health.describeDeployment(BrokerKind.Topstep, T0);
    expect(result.canEvaluate).toBe(true);
    expect(result.canEnter).toBe(false);
    expect(result.frozen).toEqual(FROZEN_WHILE_ENTRIES_SUSPENDED);
    expect(result.reason).toContain("life of this process");
  });
});

// ── The engine-wide surface the dashboard actually renders ───────────

describe("EngineHealth.snapshot — what the operator is told", () => {
  it("says nothing is frozen when nothing is", () => {
    const h = makeHealth();
    const snapshot = h.health.snapshot(T0);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.entriesHeld).toBeNull();
    expect(snapshot.frozen).toHaveLength(0);
  });

  it("names the whole tier while the feed is down", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    const snapshot = h.health.snapshot(downAt);
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.frozen).toEqual(FROZEN_WHILE_FEED_DOWN);
    // Not an *entry* hold: the feed being down is its own, louder state, and
    // reporting both would put two causes on one screen.
    expect(snapshot.entriesHeld).toBeNull();
  });

  it("reports the post-outage entry hold, which used to show a green pill", () => {
    // `degraded` was the entire surface, so for up to two bar intervals after
    // an outage the dashboard said "Connected" and `frozen` was empty while
    // `mayEnterOnBar` refused every entry.
    const h = makeHealth();
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);

    const snapshot = h.health.snapshot(recoveredAt);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.entriesHeld).toBe("post-outage-bar");
    expect(snapshot.frozen).toEqual(FROZEN_AWAITING_ENTRY_BAR);
    // The gate it is reporting agrees with it.
    expect(h.health.mayEnterOnBar(downAt).allowed).toBe(false);
  });

  it("clears the hold on the first bar that postdates the outage", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: recoveredAt }, recoveredAt + 60_000);

    const snapshot = h.health.snapshot(recoveredAt + 60_000);
    expect(snapshot.entriesHeld).toBeNull();
    expect(snapshot.frozen).toHaveLength(0);
  });

  it("reports the flap breaker, which freezes entries for the whole process", () => {
    const h = makeHealth();
    h.setEntriesSuspended(true);
    const snapshot = h.health.snapshot(T0);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.entriesHeld).toBe("flap-breaker");
    expect(snapshot.frozen).toEqual(FROZEN_WHILE_ENTRIES_SUSPENDED);
  });

  it("puts the breaker ahead of the post-outage anchor when both hold", () => {
    // The anchor clears on the next bar; the breaker does not clear at all.
    // Telling the operator to wait for a bar would be telling them to wait
    // for something that changes nothing.
    const h = makeHealth();
    h.setEntriesSuspended(true);
    const downAt = driveDown(h);
    const recoveredAt = downAt + 60_000;
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, recoveredAt);

    expect(h.health.snapshot(recoveredAt).entriesHeld).toBe("flap-breaker");
  });
});

// ── stop() semantics ─────────────────────────────────────────────────

describe("EngineHealth.reset", () => {
  it("clears a down state so a restart does not inherit an outage that ended", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    h.health.reset();
    expect(h.health.snapshot(downAt).degraded).toBe(false);
  });

  it("clears the resume anchor so a restart is not stuck refusing every entry", () => {
    const h = makeHealth();
    const downAt = driveDown(h);
    h.health.noteBarRead({ ok: true, newestBarOpenMs: downAt }, downAt + 1000);
    h.health.reset();
    expect(h.health.mayEnterOnBar(T0).allowed).toBe(true);
  });

  it("clears broker order-seam evidence", () => {
    const h = makeHealth();
    h.health.noteBrokerOrders(ACCT, false, "gone", T0);
    h.health.reset();
    expect(h.health.snapshot(T0).brokers[BrokerKind.Topstep].orders).toBe("up");
  });
});

// ── The session input ────────────────────────────────────────────────

describe("anyDeploymentInSession", () => {
  // The window is the playbook's, so two deployments with different windows
  // are two playbooks. `test-strategy` is the cash-session one every fixture
  // deployment names; `overnight-strategy` is the second.
  const moduleWithSession = (start: string, end: string) => ({
    version: "1.0.0",
    params: {},
    config: {
      name: "Test",
      description: "",
      timeframe: "1m",
      session: { start, end, timezone: "America/New_York" },
      entryType: 2,
      indicators: [],
    },
    shouldEnter: vi.fn(),
    shouldExit: vi.fn(),
  });

  beforeEach(() => {
    vi.mocked(getStrategy).mockImplementation((key: string) =>
      key === "overnight-strategy"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (moduleWithSession("18:00", "04:00") as any)
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (moduleWithSession("09:30", "16:00") as any),
    );
  });

  it("is false with no deployments — nothing is supposed to be trading", () => {
    expect(anyDeploymentInSession([], IN_WINDOW)).toBe(false);
  });

  it("is true when a deployment is inside its window", () => {
    expect(anyDeploymentInSession([deployment()], IN_WINDOW)).toBe(true);
  });

  it("is false when every deployment is outside its window", () => {
    expect(anyDeploymentInSession([deployment()], OUT_OF_WINDOW)).toBe(false);
  });

  it("is true when ANY deployment is in window, not all of them", () => {
    const overnight = deployment({
      id: "deploy-bbb",
      strategyKey: "overnight-strategy",
    });
    expect(anyDeploymentInSession([deployment(), overnight], OVERNIGHT_ONLY)).toBe(true);
    expect(anyDeploymentInSession([deployment()], OVERNIGHT_ONLY)).toBe(false);
  });

  it("skips a deployment whose strategy is not registered rather than throwing", () => {
    vi.mocked(getStrategy).mockImplementation(() => undefined);
    expect(() => anyDeploymentInSession([deployment()], IN_WINDOW)).not.toThrow();
    expect(anyDeploymentInSession([deployment()], IN_WINDOW)).toBe(false);
  });
});
