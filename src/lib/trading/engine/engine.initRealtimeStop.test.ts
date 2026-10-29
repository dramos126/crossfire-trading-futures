/**
 * `initRealtime` abandoned by a `stop()` that lands while its `connect()` is
 * in flight.
 *
 * `start()` fires `initRealtime` without awaiting it. Since the market hub's
 * `shutdown()` became a barrier, an abandoned `connect()` returns quietly
 * instead of throwing, so the pass used to go on to `syncContractSubs` on the
 * stopped engine — refilling the maps `stop()` had just cleared — and, if
 * that threw, arm the 30s polling fallback on it. That interval sets
 * `intervalId`, which nothing on a stopped engine clears and which makes
 * every later `start()` return early.
 */

import { describe, it, expect, vi } from "vitest";

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
  getAllOpenTrades: vi.fn().mockReturnValue([]),
  getReconcilableTrades: vi.fn().mockReturnValue([]),
  listAccountsWithReconcilableTrades: vi.fn().mockReturnValue([]),
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
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
  toAccountBrokerSeeds: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/db/settings", () => ({
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

import { TradingEngine, type EngineLog } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { MarketHubController } from "./engine-market-hub";

type EnginePrivates = {
  initRealtime(deployments: Deployment[]): Promise<void>;
  signalr: unknown;
  intervalId: ReturnType<typeof setInterval> | null;
  realtimeDeployments: Deployment[];
  marketHub: MarketHubController;
};

const DEPLOYMENT = {
  id: "d1",
  accountId: 4242,
  ticker: "MNQ" as TickerSymbol,
  strategyKey: "test",
  status: "Active",
  paramValues: {},
} as Deployment;

/** An engine that `start()` has just handed to `initRealtime`, with the hub's
 *  `connect()` parked until the test releases it. */
function startingEngine(sync: () => Promise<void>) {
  const engine = new TradingEngine(
    new TopstepClient("http://localhost:0"),
    new TradovateClient("http://localhost:0"),
    null,
  );
  const priv = engine as unknown as EnginePrivates;
  const logs: EngineLog[] = [];
  engine.setLogHandler((entry) => logs.push(entry));
  priv.signalr = {};
  priv.realtimeDeployments = [DEPLOYMENT];

  let releaseConnect: () => void = () => {};
  vi.spyOn(priv.marketHub, "isReady").mockReturnValue(false);
  vi.spyOn(priv.marketHub, "connect").mockImplementation(
    () => new Promise<void>((resolve) => (releaseConnect = resolve)),
  );
  const syncContractSubs = vi
    .spyOn(priv.marketHub, "syncContractSubs")
    .mockImplementation(sync);
  return { engine, priv, logs, syncContractSubs, releaseConnect: () => releaseConnect() };
}

describe("initRealtime abandoned by a stop during its connect", () => {
  it("does not sync subscriptions onto the stopped engine", async () => {
    const h = startingEngine(async () => {});
    const pass = h.priv.initRealtime([DEPLOYMENT]);

    h.engine.stop();
    h.releaseConnect();
    await pass;

    expect(h.syncContractSubs).not.toHaveBeenCalled();
    expect(h.engine.isRunning()).toBe(false);
  });

  it("arms no polling fallback when the sync throws after the stop", async () => {
    // The sync already running when the stop lands, then failing.
    const h = startingEngine(async () => {
      h.engine.stop();
      throw new Error("Contract/search 429");
    });
    vi.spyOn(h.priv.marketHub, "isReady").mockReturnValue(true);

    await h.priv.initRealtime([DEPLOYMENT]);

    expect(h.priv.intervalId).toBeNull();
    expect(h.engine.isRunning()).toBe(false);
    expect(h.logs.some((l) => l.message.includes("falling back to polling"))).toBe(false);
  });

  it("still falls back to polling when the sync throws on a running engine", async () => {
    const h = startingEngine(async () => {
      throw new Error("Contract/search 429");
    });
    vi.spyOn(h.priv.marketHub, "isReady").mockReturnValue(true);

    await h.priv.initRealtime([DEPLOYMENT]);

    expect(h.priv.intervalId).not.toBeNull();
    expect(h.logs.some((l) => l.message.includes("falling back to polling"))).toBe(true);
    h.engine.stop();
  });
});
