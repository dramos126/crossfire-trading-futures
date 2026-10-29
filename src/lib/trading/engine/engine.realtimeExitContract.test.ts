/**
 * The tick-driven exit path resolves its contract per deployment.
 *
 * A market sub is a single global slot keyed by the Topstep contract id, so
 * a Topstep leg and a Tradovate leg on the same product share one — and
 * `MarketSub.contract` holds whichever leg's contract happened to create it.
 * `evaluateRealtimeExits` used to hand that one object to every deployment on
 * the sub, so the Topstep leg's session-end exit asked Tradovate about `NQU6`,
 * got "no position", and submitted nothing. That is the 2026-08-26 root cause
 * in docs/bugs.md, "One leg of a group flattens at session end and its sibling
 * does not".
 *
 * These exercise the shipped `evaluateRealtimeExits` and assert on the
 * `Contract` each leg's `placeExitOrder` receives, which is the exact value
 * that was wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/notify/discord", () => ({
  sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
  sendOrphanAlert: vi.fn().mockResolvedValue(undefined),
  formatNyTime: vi.fn().mockReturnValue(""),
  formatAccountLabel: vi.fn().mockReturnValue(""),
  COLOR_ENTRY_LONG: 0,
  COLOR_ENTRY_SHORT: 0,
  COLOR_EXIT_WIN: 0,
  COLOR_EXIT_LOSS: 0,
  COLOR_EXIT_FLAT: 0,
  COLOR_EXIT_BE: 0,
  COLOR_EXIT_TRAIL: 0,
  COLOR_EXIT_STRATEGY: 0,
  COLOR_EXIT_MANUAL: 0,
  COLOR_BRACKET_FAILURE: 0,
  COLOR_CONNECTION_LOST: 0,
  COLOR_CONNECTION_RESTORED: 0,
  ansiGreen: (s: string) => s,
  ansiRed: (s: string) => s,
  ansiBlue: (s: string) => s,
  ansiGray: (s: string) => s,
  ANSI_LINE_WIDTH: 80,
  padAnsiLine: (s: string) => s,
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(),
  listClosingDeployments: vi.fn().mockReturnValue([]),
  listGroupLegs: vi.fn().mockReturnValue([]),
  listManagedDeployments: vi.fn().mockReturnValue([]),
  markOrphanedByAccount: vi.fn().mockReturnValue([]),
  reapDestroyingDeployment: vi.fn(),
  settlePausingDeployment: vi.fn(),
}));

vi.mock("@/lib/db/trades", () => ({
  attachPendingExit: vi.fn(),
  abandonSnapshotQueue: vi.fn(),
  backfillEntryFilledAt: vi.fn(),
  backfillExitFilledAt: vi.fn(),
  backfillExitOrderId: vi.fn(),
  closeTrade: vi.fn(),
  findRecentApproximatedTradeByAccountContract: vi.fn(),
  findTradeByAccountContract: vi.fn().mockReturnValue(null),
  getAllOpenTrades: vi.fn().mockReturnValue([]),
  getApproximatedClosedTrades: vi.fn().mockReturnValue([]),
  getBracketManualClosedTrades: vi.fn().mockReturnValue([]),
  getAccountRealizedSinceGross: vi.fn().mockReturnValue(0),
  getLastExitAt: vi.fn(),
  getOpenTradeForDeployment: vi.fn(),
  getReconcilableTrades: vi.fn().mockReturnValue([]),
  getRecentlyClosedTrades: vi.fn().mockReturnValue([]),
  getTradeById: vi.fn(),
  getTradesNeedingTimestampHeal: vi.fn().mockReturnValue([]),
  healApproximatedExit: vi.fn(),
  incrementSnapshotRetry: vi.fn(),
  insertPendingEntry: vi.fn(),
  listAccountsNeedingTimestampHeal: vi.fn().mockReturnValue([]),
  listAccountsWithBracketManualClosedTrades: vi.fn().mockReturnValue([]),
  listAccountsWithReconcilableTrades: vi.fn().mockReturnValue([]),
  listAllAccountsWithApproximatedTrades: vi.fn().mockReturnValue([]),
  listDueSnapshots: vi.fn().mockReturnValue([]),
  listSessionLatchedEntries: vi.fn().mockReturnValue([]),
  markBreakEvenMoved: vi.fn(),
  markSlTrailEngaged: vi.fn(),
  markEntryFailed: vi.fn(),
  markEntryFilled: vi.fn(),
  saveTradeBars: vi.fn(),
  setBracketOrderIds: vi.fn(),
  setEntryOrderId: vi.fn(),
  setExitReason: vi.fn(),
}));

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(),
  listGroups: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/tradovate-order-map", () => ({
  findActiveOrderMappingsByAccount: vi.fn().mockReturnValue([]),
  markTerminal: vi.fn(),
}));

// `BrokerKind` is a string const enum that does not inline under this
// transpiler — engine code reads it off this module (patterns.md).
vi.mock("@/lib/db/account-brokers", () => ({
  BrokerKind: { Topstep: "topstep", Tradovate: "tradovate" },
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
  toAccountBrokerSeeds: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue(null),
  getTradovateApiSecret: vi.fn().mockReturnValue(null),
  getTradovateAppId: vi.fn().mockReturnValue(null),
  getTradovateAppVersion: vi.fn().mockReturnValue(null),
  getTradovateDeviceId: vi.fn().mockReturnValue(null),
  getTradovatePassword: vi.fn().mockReturnValue(null),
  getTradovateUsername: vi.fn().mockReturnValue(null),
  getTopstepApiKey: vi.fn().mockReturnValue(null),
  getTopstepUsername: vi.fn().mockReturnValue(null),
  getTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  getNotificationsEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/db/settings-cache", () => ({
  resolveTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  invalidateSettingsCache: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("@/lib/db/engine-logs", () => ({
  appendLog: vi.fn(),
  getRecentLogs: vi.fn().mockReturnValue([]),
}));

// Enumerated, not spread: `trading/strategies` reaches the `require.context`
// strategy loader, which has no vitest equivalent (patterns.md).
vi.mock("@/lib/trading/strategies/index", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn(),
  listStrategies: vi.fn().mockReturnValue([]),
}));

import { TradingEngine, type ContractSub, type DeploymentState, type EngineLog, type MarketSub } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
// The real constructor, because this class of defect is only reachable through
// it: the countdown is interpolated at construction, so a hand-rolled `Error`
// carrying the same words would pass a test the shipped error fails.
import { TradovateCircuitOpenError } from "@/lib/brokers/tradovate/errors";
import { executionContractId } from "../broker-access/contract-resolver";
import { EntryExitCode } from "../orders/entry-exit-codes";
import { getStrategy } from "../strategies";
import { resetLogBursts } from "@/lib/logging/pipe";
import type { Contract } from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { OpenPosition, StrategyModule } from "../strategy-types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Both ids are the ones the live engine logged on 2026-08-26 (bugs.md). */
const TOPSTEP_CONTRACT_ID = "CON.F.US.ENQ.U26";
const TRADOVATE_SYMBOL = "NQU6";

const ACCT_TOPSTEP = 90063379;
const ACCT_TRADOVATE = 71001;
const DEPL_TOPSTEP = "depl-topstep";
const DEPL_TRADOVATE = "depl-tradovate";
const TICKER = "/NQ" as TickerSymbol;
const TF = "1m";

/** The tick size on the shared market sub. Deliberately different from the
 *  one the per-deployment resolve answers with, so a test can tell which
 *  object a tick param came from. Real contracts agree on both. */
const SUB_TICK_SIZE = 0.25;
const RESOLVED_TICK_SIZE = 99;

function contract(over: Partial<Contract> = {}): Contract {
  return {
    id: TOPSTEP_CONTRACT_ID,
    name: "NQU6",
    description: "E-mini Nasdaq",
    tickSize: SUB_TICK_SIZE,
    tickValue: 5,
    activeContract: true,
    symbolId: "F.US.ENQ",
    ...over,
  };
}

/** Both legs share `PARENT_ID`: this is one mixed-broker deployment, which
 *  is an ordinary shape now rather than the exotic one the incident found. */
const PARENT_ID = "parent-1";

function deployment(id: string, accountId: number, over: Partial<Deployment> = {}): Deployment {
  return {
    id,
    accountId,
    ticker: TICKER,
    strategyKey: "test",
    status: "Active",
    groupId: PARENT_ID,
    paramValues: {},
    ...over,
  } as Deployment;
}

function position(): OpenPosition {
  return {
    side: 0,
    entryPrice: 20_000,
    entryTimestamp: "2026-08-26T17:00:00.000Z",
    barsSinceEntry: 3,
    entryFilledAt: "2026-08-26T17:00:01.000Z",
    size: 1,
    slTicks: 40,
  } as OpenPosition;
}

type ExitCall = {
  deployment: Deployment;
  contract: Contract;
  reason: string;
};

type EnginePrivates = {
  evaluateRealtimeExits(contractId: string, price: number): Promise<void>;
  getState(deploymentId: string): DeploymentState;
  realtimeDeployments: Deployment[];
  resolver: { resolve(ticker: TickerSymbol, accountId: number): Promise<Contract> };
  marketHub: {
    marketSubs: Map<string, MarketSub>;
    contractSubs: Map<string, ContractSub>;
  };
  placeExitOrder(
    strategy: StrategyModule,
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    activeTradeId: number | null,
    reason: string,
  ): Promise<void>;
};

/**
 * An engine holding two live legs on one market sub — the multi-broker group
 * the incident needed. The sub carries the *Tradovate* leg's contract, which
 * is what happens whenever that leg subscribes first.
 */
function makeHarness(opts: { resolve?: (accountId: number) => Promise<Contract> } = {}) {
  const engine = new TradingEngine(
    new TopstepClient("http://localhost:0"),
    new TradovateClient("http://localhost:0"),
    null,
  );
  const priv = engine as unknown as EnginePrivates;
  const logs: EngineLog[] = [];
  engine.setLogHandler((entry) => logs.push(entry));

  const sharedContract = contract({ executionContractId: TRADOVATE_SYMBOL });
  priv.marketHub.marketSubs.set(TOPSTEP_CONTRACT_ID, {
    contract: sharedContract,
    refCount: 2,
    timeframes: new Set([TF]),
    lastTickPrice: null,
  } as MarketSub);
  priv.marketHub.contractSubs.set(`${TOPSTEP_CONTRACT_ID}|${TF}`, {
    contractId: TOPSTEP_CONTRACT_ID,
    contract: sharedContract,
    timeframe: TF,
    refs: new Set([DEPL_TOPSTEP, DEPL_TRADOVATE]),
  } as unknown as ContractSub);

  const topstepLeg = deployment(DEPL_TOPSTEP, ACCT_TOPSTEP);
  const tradovateLeg = deployment(DEPL_TRADOVATE, ACCT_TRADOVATE);
  priv.realtimeDeployments = [topstepLeg, tradovateLeg];
  for (const id of [DEPL_TOPSTEP, DEPL_TRADOVATE]) {
    priv.getState(id).position = position();
  }

  // Stands in for `BrokerAwareContractResolver.resolve`, which has its own
  // tests: Topstep accounts get a bare Topstep contract, Tradovate accounts
  // get the same contract carrying the dated symbol.
  const defaultResolve = async (accountId: number): Promise<Contract> =>
    accountId === ACCT_TRADOVATE
      ? contract({ tickSize: RESOLVED_TICK_SIZE, executionContractId: TRADOVATE_SYMBOL })
      : contract({ tickSize: RESOLVED_TICK_SIZE });
  const resolve = vi.fn((_ticker: TickerSymbol, accountId: number) =>
    (opts.resolve ?? defaultResolve)(accountId),
  );
  priv.resolver.resolve = resolve;

  const exits: ExitCall[] = [];
  const placeExitOrder = vi.fn(
    async (
      _strategy: StrategyModule,
      d: Deployment,
      c: Contract,
      _position: OpenPosition,
      _activeTradeId: number | null,
      reason: string,
    ) => {
      exits.push({ deployment: d, contract: c, reason });
    },
  );
  priv.placeExitOrder = placeExitOrder;

  return { engine, priv, logs, exits, resolve, placeExitOrder, sharedContract };
}

function exitFor(exits: ExitCall[], deploymentId: string): ExitCall | undefined {
  return exits.find((e) => e.deployment.id === deploymentId);
}

/** No `config.session` ⇒ no windows ⇒ outside all of them ⇒ force-close. */
function outOfSessionStrategy(over: Partial<StrategyModule> = {}): StrategyModule {
  return { key: "test", params: {}, config: {}, ...over } as unknown as StrategyModule;
}

/** The same fixture with a cash-session window, so the force-close arm is
 *  skipped and the realtime hook runs. The window is the playbook's. */
const IN_SESSION_CONFIG = {
  session: { start: "09:30", end: "16:00", timezone: "America/New_York" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-26T18:00:00.000Z")); // 14:00 New York
  // The log pipe's burst collapser is process-wide module state keyed on
  // `(cause, deployment)` inside a 30s window — and the pinned clock above
  // means that window never advances, so a warning this file asserts on in
  // one test folds into the previous test's row and vanishes.
  resetLogBursts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateRealtimeExits — execution identity is per deployment", () => {
  it("is one deployment on one sub, which is what makes the rest of this file ordinary", () => {
    // The mixed-broker gate is deleted, so a Topstep leg and a Tradovate leg
    // under one parent is a shape an operator can create from the editor —
    // not the exotic configuration the 2026-08-26 incident happened to hit.
    // Market-data identity is shared; every assertion below is that
    // execution identity is not.
    const { priv } = makeHarness();

    expect(priv.realtimeDeployments.map((d) => d.groupId)).toEqual([PARENT_ID, PARENT_ID]);
    expect(priv.marketHub.marketSubs.size).toBe(1);
    expect(executionContractId(priv.marketHub.marketSubs.get(TOPSTEP_CONTRACT_ID)!.contract)).toBe(
      TRADOVATE_SYMBOL,
    );
  });

  it("gives each leg on a shared market sub its own broker's execution id", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, exits } = makeHarness();

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(exits).toHaveLength(2);
    const topstep = exitFor(exits, DEPL_TOPSTEP);
    const tradovate = exitFor(exits, DEPL_TRADOVATE);
    expect(topstep?.reason).toBe("time_window_close");
    expect(executionContractId(topstep!.contract)).toBe(TOPSTEP_CONTRACT_ID);
    expect(executionContractId(tradovate!.contract)).toBe(TRADOVATE_SYMBOL);
  });

  it("gives each leg its own execution id on the `realtime_exit` arm too", async () => {
    // Every other contract assertion in this file runs through the
    // `time_window_close` arm. Both arms call `dispatchTickExit`, so today they
    // cannot differ — which is exactly the shape a refactor breaks silently by
    // resolving in one caller and not the other.
    vi.mocked(getStrategy).mockReturnValue(
      outOfSessionStrategy({
        config: IN_SESSION_CONFIG,
        shouldExitRealtime: () => true,
      } as unknown as Partial<StrategyModule>),
    );
    const { priv, exits } = makeHarness();

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(exits).toHaveLength(2);
    const topstep = exitFor(exits, DEPL_TOPSTEP);
    const tradovate = exitFor(exits, DEPL_TRADOVATE);
    expect(topstep?.reason).toBe("realtime_exit");
    expect(tradovate?.reason).toBe("realtime_exit");
    expect(executionContractId(topstep!.contract)).toBe(TOPSTEP_CONTRACT_ID);
    expect(executionContractId(tradovate!.contract)).toBe(TRADOVATE_SYMBOL);
  });

  it("resolves once per leg, with that leg's own account id", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, resolve } = makeHarness();

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(TICKER, ACCT_TOPSTEP);
    expect(resolve).toHaveBeenCalledWith(TICKER, ACCT_TRADOVATE);
  });

  it("skips a leg whose contract resolve throws and still evaluates the other", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, exits, logs } = makeHarness({
      resolve: async (accountId) => {
        if (accountId === ACCT_TOPSTEP) throw new Error("no Topstep client configured");
        return contract({ executionContractId: TRADOVATE_SYMBOL });
      },
    });

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(exits.map((e) => e.deployment.id)).toEqual([DEPL_TRADOVATE]);
    const warned = logs.find(
      (l) => l.deploymentId === DEPL_TOPSTEP && l.level === "warn",
    );
    expect(warned?.message).toContain("no Topstep client configured");
    // The mirror is kept so the next tick retries.
    expect(priv.getState(DEPL_TOPSTEP).position).not.toBeNull();
  });

  it("keeps the failed leg's position and clears the succeeding leg's", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv } = makeHarness({
      resolve: async (accountId) => {
        if (accountId === ACCT_TOPSTEP) throw new Error("boom");
        return contract({ executionContractId: TRADOVATE_SYMBOL });
      },
    });

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(priv.getState(DEPL_TOPSTEP).position).not.toBeNull();
    expect(priv.getState(DEPL_TRADOVATE).position).toBeNull();
  });

  it("does not dispatch an exit for a leg whose position was nulled during the resolve", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const harness = makeHarness({
      resolve: async (accountId) => {
        // A user-hub close event lands while the resolve is in flight. This
        // is the read the dispatch must not be holding from before the await.
        harness.priv.getState(
          accountId === ACCT_TOPSTEP ? DEPL_TOPSTEP : DEPL_TRADOVATE,
        ).position = null;
        return contract();
      },
    });

    await harness.priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(harness.exits).toEqual([]);
  });
});

describe("evaluateRealtimeExits — tick params stay on the shared market sub", () => {
  it("hands shouldExitRealtime the sub's tickSize, not the resolved contract's", async () => {
    const seen: number[] = [];
    vi.mocked(getStrategy).mockReturnValue(
      outOfSessionStrategy({
        config: IN_SESSION_CONFIG,
        shouldExitRealtime: (ctx: { tickSize: number }) => {
          seen.push(ctx.tickSize);
          return false;
        },
      } as unknown as Partial<StrategyModule>),
    );
    const { priv } = makeHarness();

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(seen).toEqual([SUB_TICK_SIZE, SUB_TICK_SIZE]);
  });

  it("does not resolve a contract on a tick that exits nothing", async () => {
    vi.mocked(getStrategy).mockReturnValue(
      outOfSessionStrategy({
        config: IN_SESSION_CONFIG,
        shouldExitRealtime: () => false,
      } as unknown as Partial<StrategyModule>),
    );
    const { priv, resolve } = makeHarness();

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(resolve).not.toHaveBeenCalled();
  });
});

/**
 * What the tick path *says* when a dispatch fails, and how often.
 *
 * `evaluateRealtimeExits` runs on every price change with no throttle of its
 * own, so a leg the exit machinery cannot clear re-enters the same catch arm
 * per tick. Two arms feed it — `time_window_close` and `realtime_exit` — and
 * every case in this file's other describes drives only the first, which is
 * the shape where a refactor silently loses one caller's handling.
 */
describe("evaluateRealtimeExits — the exit-dispatch catch arm", () => {
  /** In session, hook returns true ⇒ the `realtime_exit` arm. */
  function realtimeExitStrategy(): StrategyModule {
    return outOfSessionStrategy({
      config: IN_SESSION_CONFIG,
      shouldExitRealtime: () => true,
    } as unknown as Partial<StrategyModule>);
  }

  function warnsFor(logs: EngineLog[], deploymentId: string): string[] {
    return logs
      .filter((l) => l.deploymentId === deploymentId && l.level === "warn")
      .map((l) => l.message);
  }

  it("names the failing arm and keeps the mirror when `realtime_exit` throws", async () => {
    // The `time_window_close` twin of this is covered above; this arm had no
    // failure case at all, so a catch that stopped keeping the mirror — the
    // thing that makes the next tick retry — would not have failed anything.
    vi.mocked(getStrategy).mockReturnValue(realtimeExitStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(new Error("broker 503"));

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    const warns = warnsFor(logs, DEPL_TOPSTEP);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("realtime_exit");
    expect(warns[0]).toContain("broker 503");
    expect(priv.getState(DEPL_TOPSTEP).position).not.toBeNull();
    expect(priv.getState(DEPL_TRADOVATE).position).not.toBeNull();
  });

  // The latch's own refusal is the one arrival frequent enough to drown the
  // log — it already logged at `info` inside `placeExitOrder`, and a tick storm
  // produces one per quote. Both arms must swallow it.
  it.each([
    ["time_window_close", () => outOfSessionStrategy()],
    ["realtime_exit", realtimeExitStrategy],
  ])("says nothing when the %s arm loses the exit latch", async (_arm, strategy) => {
    vi.mocked(getStrategy).mockReturnValue(strategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(new Error(EntryExitCode.EXIT_IN_FLIGHT));

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(warnsFor(logs, DEPL_TOPSTEP)).toEqual([]);
    expect(warnsFor(logs, DEPL_TRADOVATE)).toEqual([]);
  });

  /**
   * A47. `EXIT_FLAT_MISMATCH` is a *standing* condition: it holds from the
   * moment an exogenous exit flattens the book until the reconciler closes the
   * row, which is minutes on a quiet product. The throw site throttles its own
   * warn to one line per stranded trade; the burst it removed arrived intact
   * one frame up until this arm throttled too. Six ticks, one line — and a real
   * /NQ minute is far more than six ticks.
   *
   * The count is asserted exactly so the cadence is measured rather than
   * assumed. The throw is untouched: every tick still keeps the mirror.
   */
  it("says the same thing once for a leg stranded on the same condition", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(new Error(EntryExitCode.EXIT_FLAT_MISMATCH));

    for (let i = 0; i < 6; i++) {
      await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050 + i);
    }

    expect(warnsFor(logs, DEPL_TOPSTEP)).toHaveLength(1);
    expect(priv.getState(DEPL_TOPSTEP).position).not.toBeNull();
  });

  // The throttle is keyed on the arm and the error text, not on the deployment
  // alone: a leg stranded on one condition must not silence the *next*,
  // different failure. That is the difference between a quiet log and a deaf
  // one, and it is the only reason a 5-minute window is safe here.
  it("announces a different failure immediately, mid-throttle", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(new Error(EntryExitCode.EXIT_FLAT_MISMATCH));

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_051);
    placeExitOrder.mockRejectedValue(new Error("broker 503"));
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_052);
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_053);

    const warns = warnsFor(logs, DEPL_TOPSTEP);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain(EntryExitCode.EXIT_FLAT_MISMATCH);
    expect(warns[1]).toContain("broker 503");
  });

  /**
   * The throttle is a single-slot *last-key* anchor, so any varying token in
   * the message defeats it outright — every pass mismatches the previous key,
   * restamps, and speaks. `TradovateCircuitOpenError` is the reachable case
   * and it is the worst one: `assertCircuitClosed` runs before every wire
   * call and throws a freshly constructed error whose message carries
   * `${remainMs}ms remaining`, computed at construction. `placeExitOrder-
   * Inner` opens with `searchOpenPositions`, whose catch arm rethrows
   * unlogged, so this arm is the only voice for it — and `circuit_open` is
   * outside the orphan-pause set, so nothing else fires either. A p-captcha
   * circuit is open for an hour.
   *
   * Built through the real constructor deliberately: a hand-rolled `Error`
   * with a fixed message passes whether or not the key is normalised.
   */
  it("does not re-announce per quote when the message carries a countdown", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    const openedAt = Date.now();
    placeExitOrder.mockImplementation(async () => {
      throw new TradovateCircuitOpenError("/position/list", ACCT_TOPSTEP, openedAt, 3_600_000);
    });

    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(Date.now() + 250));
      await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050 + i);
    }

    const warns = warnsFor(logs, DEPL_TOPSTEP);
    expect(warns).toHaveLength(1);
    // Normalised in the key, never in the line: the operator still sees how
    // much of the lockout is left.
    expect(warns[0]).toMatch(/\d+ms remaining/);
  });

  /**
   * The other edge of the same normalisation, and the reason it stops at four
   * digits: an HTTP status is exactly three. Both clients' transport wrappers
   * put the status in the message and nothing else in it varies — a plain
   * `Error` reading `Tradovate API error <status> on <path>: (empty body)` —
   * so collapsing every digit run made rate-limited and gateway-down the same
   * key, and the second one was silenced for the rest of the 300s window.
   * They are different incidents with different operator actions, and on the
   * `searchOpenPositions`-throw arm this line is the only voice for either:
   * `circuit_open` and `network` are both outside the orphan-pause set.
   */
  it("announces a second HTTP status on the same path, trade and arm", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(
      new Error("Tradovate API error 429 on /order/placeOrder: (empty body)"),
    );
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    vi.setSystemTime(new Date(Date.now() + 90_000));
    placeExitOrder.mockRejectedValue(
      new Error("Tradovate API error 502 on /order/placeOrder: (empty body)"),
    );
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_051);

    const warns = warnsFor(logs, DEPL_TOPSTEP);
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("429");
    expect(warns[1]).toContain("502");
  });

  /**
   * The trade-id axis, which the sibling anchor at the throw site has always
   * carried. Without it the sequence *strand → reconciler closes the row →
   * new entry fills → strands the same way* is one incident's worth of log
   * for two incidents: identical key, anchor still inside the window,
   * silenced. For `EXIT_FLAT_MISMATCH` the throw site would still speak
   * (its key carries the trade), but for the `searchOpenPositions`-throw arm
   * nothing else logs at all.
   */
  it("re-announces the same failure when a new trade strands the same way", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(new Error(EntryExitCode.EXIT_FLAT_MISMATCH));
    priv.getState(DEPL_TOPSTEP).activeTradeId = 6876;

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_051);
    expect(warnsFor(logs, DEPL_TOPSTEP)).toHaveLength(1);

    // The reconciler closed #6876 and a fresh entry filled, well inside the
    // 300s window.
    priv.getState(DEPL_TOPSTEP).activeTradeId = 7001;
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_052);

    expect(warnsFor(logs, DEPL_TOPSTEP)).toHaveLength(2);
  });

  // One leg's failure must not suppress the other's line. They are different
  // accounts on different brokers; "the group is stuck" and "one leg is stuck"
  // are different incidents and the log is where they are told apart.
  it("reports both legs when both fail on the same tick", async () => {
    vi.mocked(getStrategy).mockReturnValue(outOfSessionStrategy());
    const { priv, logs, placeExitOrder } = makeHarness();
    placeExitOrder.mockRejectedValue(new Error("broker 503"));

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);

    expect(warnsFor(logs, DEPL_TOPSTEP)).toHaveLength(1);
    expect(warnsFor(logs, DEPL_TRADOVATE)).toHaveLength(1);
  });
});

/**
 * A14. The quote tick is the hottest path in the engine — every price change,
 * every leg holding a position — and it merged the deployment's params afresh
 * on each one. The merge is cached per deployment and dropped by `sync()`, the
 * only place a running engine learns a deployment's params changed.
 */
describe("evaluateRealtimeExits — the tick's params", () => {
  function recordingStrategy(seen: unknown[]): StrategyModule {
    return outOfSessionStrategy({
      params: { stopTicks: { type: "number", default: 40 } },
      config: IN_SESSION_CONFIG,
      shouldExitRealtime: (ctx: { params: unknown }) => {
        seen.push(ctx.params);
        return false;
      },
    } as unknown as Partial<StrategyModule>);
  }

  it("hands two ticks on one deployment the same params object", async () => {
    const seen: unknown[] = [];
    vi.mocked(getStrategy).mockReturnValue(recordingStrategy(seen));
    const { engine, priv } = makeHarness();
    engine.sync([priv.realtimeDeployments[0]]);

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_051);

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it("builds a new one after a sync that changes the deployment's params", async () => {
    const seen: unknown[] = [];
    vi.mocked(getStrategy).mockReturnValue(recordingStrategy(seen));
    const { engine, priv } = makeHarness();
    const leg = priv.realtimeDeployments[0];
    engine.sync([leg]);
    priv.getState(leg.id).position = position();

    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_050);
    engine.sync([{ ...leg, paramValues: { stopTicks: 55 } }]);
    priv.getState(leg.id).position = position();
    await priv.evaluateRealtimeExits(TOPSTEP_CONTRACT_ID, 20_051);

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[0]).toMatchObject({ stopTicks: 40 });
    expect(seen[1]).toMatchObject({ stopTicks: 55 });
  });
});

// The boundedness argument behind both throttle anchors — "`applySync` prunes
// this map" — is asserted in `engine.sync.test.ts`, which owns the whole
// `sync()` path. It used to be unassertable anywhere: A48.
