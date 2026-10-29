/**
 * An account's `BrokerKind` changing under a running engine re-routes every
 * subsequent order for that account — it is what picks the contract, and the
 * 2026-08-26 incident (docs/bugs.md, "One leg of a group flattens at session
 * end and its sibling does not") took a night to localise because nothing
 * recorded that it had happened.
 *
 * The assertion that matters is *which* log the line goes to: `engine_logs`
 * survives the process and is what `/logs` renders, while `log.*` from
 * `@/lib/logger` is console-only and is exactly why the evidence was lost.
 * So this exercises the engine's own `this.log` path via `setLogHandler`,
 * not the registry's return value — `broker-registry.test.ts` owns that half.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB + heavy-dependency stubs (must be hoisted) ─────────────────────────────

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
  markBreakEvenMoved: vi.fn(),
  markSlTrailEngaged: vi.fn(),
  markEntryFailed: vi.fn(),
  markEntryFilled: vi.fn(),
  saveTradeBars: vi.fn(),
  setBracketOrderIds: vi.fn(),
  setEntryOrderId: vi.fn(),
  setExitReason: vi.fn(),
  backfillExitOrderId: vi.fn(),
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
// transpiler, and `BrokerRegistry.refresh()` — which these tests do run —
// reads `BrokerKind.Topstep` off this module. A bare factory without it
// throws inside the fan-out. See docs/modules/testing/patterns.md.
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

vi.mock("@/lib/trading/strategies/index", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/trading/strategies", () => ({
  STRATEGIES: {},
  getStrategy: vi.fn().mockReturnValue(undefined),
  listStrategies: vi.fn().mockReturnValue([]),
}));

// ── Imports (after vi.mock hoisting) ──────────────────────────────────────────

import { TradingEngine, type EngineLog } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { BrokerRegistry } from "@/lib/brokers/registry";
import type { Account } from "@/lib/brokers/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The real name Topstep issued, per docs/bugs.md — a Combine. */
const ACCOUNT_ID = 90063379;
const ACCOUNT_NAME = "50KTC-V2-100200-90020038";

function account(broker: "topstep" | "tradovate"): Account {
  return {
    id: ACCOUNT_ID,
    name: ACCOUNT_NAME,
    balance: 50_000,
    canTrade: true,
    isVisible: true,
    broker,
    practice: false,
  };
}

function makeEngine(
  topstepSearch: ReturnType<typeof vi.fn>,
  tradovateSearch: ReturnType<typeof vi.fn>,
): { engine: TradingEngine; logs: EngineLog[] } {
  const topstepClient = new TopstepClient("http://localhost:0");
  const tradovateClient = new TradovateClient("http://localhost:0");
  const patch = (client: object, props: Record<string, unknown>) =>
    Object.assign(client as Record<string, unknown>, props);
  patch(topstepClient, { searchAccounts: topstepSearch });
  patch(tradovateClient, {
    searchAccounts: tradovateSearch,
    getDatedSymbolForContractId: vi.fn().mockReturnValue(null),
    warmContractId: vi.fn().mockResolvedValue(undefined),
  });

  const engine = new TradingEngine(topstepClient, tradovateClient, null, new BrokerRegistry());
  const logs: EngineLog[] = [];
  engine.setLogHandler((entry) => logs.push(entry));
  return { engine, logs };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshBrokerRegistry — a broker-kind change is durable-logged", () => {
  it("reports the account, both kinds and the name at error", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([account("topstep")]);
    const tradovateSearch = vi.fn().mockResolvedValue([]);
    const { engine, logs } = makeEngine(topstepSearch, tradovateSearch);
    await engine.refreshBrokerRegistry();

    topstepSearch.mockResolvedValueOnce([]);
    tradovateSearch.mockResolvedValueOnce([account("tradovate")]);
    logs.length = 0;
    await engine.refreshBrokerRegistry();

    const errors = logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(String(ACCOUNT_ID));
    expect(errors[0].message).toContain(ACCOUNT_NAME);
    expect(errors[0].message).toContain("topstep");
    expect(errors[0].message).toContain("tradovate");
  });

  // A first sighting is how every account enters the registry. Alarming on it
  // would put an error line per account into `engine_logs` on every boot.
  it("stays quiet when an account is mapped for the first time", async () => {
    const { engine, logs } = makeEngine(
      vi.fn().mockResolvedValue([account("topstep")]),
      vi.fn().mockResolvedValue([]),
    );

    await engine.refreshBrokerRegistry();

    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("stays quiet when the mapping is unchanged", async () => {
    const { engine, logs } = makeEngine(
      vi.fn().mockResolvedValue([account("topstep")]),
      vi.fn().mockResolvedValue([]),
    );
    await engine.refreshBrokerRegistry();
    logs.length = 0;

    await engine.refreshBrokerRegistry();

    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });
});
