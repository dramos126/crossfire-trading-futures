/**
 * Unit tests for engine-singleton.ts → getTradovateClientIfConfigured().
 *
 * Post-Phase-7 the Tradovate client lifecycle lives on the
 * TradovateBrokerPlugin instance (resolved through the broker registry
 * singleton), not on globalThis. These tests therefore mock the real
 * client path the plugin imports (`@/lib/brokers/tradovate/client`) and
 * assert against the plugin's `getClient()` rather than poking
 * globalThis.__topstepEngineState__.
 *
 * The engine state global still needs resetting between tests because
 * other engine-singleton helpers stash state there; the Tradovate
 * lifecycle assertions read from the plugin instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (must be hoisted) ───────────────────────────────────────────

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => { throw new Error("getDb() not available in test"); }),
  registerMigration: vi.fn(),
}));

// `hydrateRings` is hoisted out so the hydration-ordering test can seed a
// previous process's rows. The store's own sink registration is mocked away
// with the module, so the pipe reaches no database here.
const H = vi.hoisted(() => ({
  hydrateRings: vi.fn(() => ({
    main: [] as Array<import("@/lib/logging/pipe").LegacyLogEntry>,
    heartbeat: [] as Array<import("@/lib/logging/pipe").LegacyLogEntry>,
  })),
}));

vi.mock("@/lib/db/engine-logs", () => ({
  appendLog: vi.fn(),
  getRecentLogs: vi.fn().mockReturnValue([]),
  persistEngineLog: vi.fn(),
  hydrateRings: H.hydrateRings,
  startEngineLogStore: vi.fn(),
  clearPersistedLogs: vi.fn(),
}));

vi.mock("@/lib/db/settings", () => ({
  getTradovateApiCid: vi.fn().mockReturnValue("cid"),
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
  // The two the Topstep plugin's `isConfigured()` reads. Null keeps this an
  // unconfigured Topstep, which is what lets `getEngine()` run here without
  // a client, a token or a hub.
  resolveTopstepUsername: vi.fn().mockReturnValue(null),
  resolveTopstepApiKey: vi.fn().mockReturnValue(null),
  invalidateSettingsCache: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("@/lib/db/deployments", () => ({
  getDeployment: vi.fn(),
  listClosingDeployments: vi.fn().mockReturnValue([]),
  listGroupLegs: vi.fn().mockReturnValue([]),
  listManagedDeployments: vi.fn().mockReturnValue([]),
  markOrphanedByAccount: vi.fn(),
  reapDestroyingDeployment: vi.fn(),
  settlePausingDeployment: vi.fn(),
}));

vi.mock("@/lib/db/account-brokers", () => ({
  getAccountBrokerOrTopstep: vi.fn().mockReturnValue("topstep"),
  getAccountDailyPnlLimits: vi.fn(() => ({
    dailyMaxLossUsd: 0,
    dailyMaxProfitUsd: 0,
    dailyPnlIncludeUnrealized: false,
  })),
  setAccountBrokers: vi.fn(),
  listAccountIdsForBroker: vi.fn().mockReturnValue([]),
}));

const mockSendDiscordAlert = vi.fn().mockResolvedValue(undefined);
// Spread the original rather than listing exports, per patterns.md. This
// module is reached transitively — `engine-notify.ts` reads ANSI_LINE_WIDTH
// at module load to build its gap row — and a bare factory turns any such
// read into a missing-export failure in a test that does not care about it.
vi.mock("@/lib/notify/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/discord")>()),
  sendDiscordAlert: (...args: unknown[]) => mockSendDiscordAlert(...args),
  sendConnectionAlert: vi.fn().mockResolvedValue(undefined),
  COLOR_CONNECTION_LOST: 0,
  COLOR_CONNECTION_RESTORED: 0,
}));

vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), event: vi.fn() },
}));

vi.mock("@/lib/brokers/topstep/auth", () => ({
  getEngineToken: vi.fn().mockResolvedValue("test-token"),
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
  setTradeWriteListener: vi.fn(),
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

// TradovateClient: authenticate is a shared module-level vi.fn so tests
// can control its resolution without needing the instance reference.
// Mock targets `@/lib/brokers/tradovate/client` — the canonical path the
// plugin imports from.
const mockAuthenticate = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/brokers/tradovate/client", () => {
  const readTradovateCredentialsFromDb = vi.fn().mockReturnValue(null);
  class TradovateClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticate: (...args: any[]) => Promise<void>;
    // Return 0 (expired) so the idempotency guard in initialize() never
    // short-circuits — tests that set _everAuthenticated still exercise authenticate().
    getTokenExpiresAt = vi.fn().mockReturnValue(0);
    // The plugin disposes every client it drops (its renew-ahead timer must
    // not outlive it); the fake needs the method so a drop does not throw.
    dispose = vi.fn();
    constructor() {
      this.authenticate = mockAuthenticate;
    }
  }
  return { TradovateClient, readTradovateCredentialsFromDb };
});

// A class, not an object literal. `TradingEngine`'s constructor does
// `new BrokerRegistry({ topstep, tradovate })`, so a bare object is
// "BrokerRegistry is not a constructor" for every test that drives the real
// `getEngine()` — which the two hydration cases below do. The instance
// surface is empty on purpose: the engine's constructor only stores the
// registry and hands `brokerKind` to the resolver as an unevaluated
// closure, so nothing this file reaches calls a method on it. A test that
// starts ticking should meet a loud TypeError, not a stub.
vi.mock("@/lib/trading/broker-access/broker-registry", () => ({
  BrokerRegistry: class {
    static tradovateExpected = vi.fn().mockReturnValue(true);
  },
  // Constructed by an engine field initializer, so every `getEngine()` reads it.
  TradovateAlertEpisode: class {
    failing = null;
  },
}));

// The lease's own rules are pinned in `db/lease.test.ts`; here only the
// doors' refusals are asserted, and the engine's `start()` door never runs.
const LEASE = vi.hoisted(() => ({ held: true, reportLeaseRefused: vi.fn() }));
vi.mock("@/lib/db/lease", () => ({
  holdsLease: () => LEASE.held,
  leaseGate: () => () => LEASE.held,
  reportLeaseRefused: LEASE.reportLeaseRefused,
}));

const BOOT = vi.hoisted(() => ({ runBootSequence: vi.fn() }));
vi.mock("@/lib/trading/engine/boot/boot-engine", () => ({ runBootSequence: BOOT.runBootSequence }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  activateFromSettings,
  getEngine,
  getEngineIfReady,
  getLogsBuffer,
  getLogsByLevel,
  getTradovateClientIfConfigured,
} from "./engine-singleton";
import { logRings } from "./engine-log-sinks";
import {
  consoleLog,
  emit,
  resetLogBursts,
  setLogSink,
  type BurstUpdate,
  type LegacyLogEntry,
  type RingLogEntry,
} from "@/lib/logging/pipe";
import { readTradovateCredentialsFromDb, TradovateClient } from "@/lib/brokers/tradovate/client";
import { BrokerRegistry } from "@/lib/trading/broker-access/broker-registry";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import type { TradovateBrokerPlugin } from "@/lib/brokers/tradovate/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

const GLOBAL_KEY = "__topstepEngineState__";
const RINGS_KEY = "__crossfireLogRings__";

/** Reset the engine global, the log rings + the plugin's internal state
 *  between tests so each test starts from a clean slate. The plugin is a
 *  process-singleton registered in registry-singleton.ts, so its private
 *  fields persist across tests unless we reach in to clear them. */
function resetGlobalState(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  delete (globalThis as Record<string, unknown>)[RINGS_KEY];
  mockSendDiscordAlert.mockClear();
  mockSendDiscordAlert.mockResolvedValue(undefined);
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue(undefined);

  // Reset plugin private state. Cast through unknown→record because we
  // intentionally poke private fields here (test-only invariant: the
  // plugin's lifecycle assertions need a clean slate per test).
  const plugin = brokerRegistry.getPlugin("tradovate") as unknown as Record<string, unknown>;
  plugin._client = null;
  plugin._everAuthenticated = false;
  plugin.lastTradovateAuthAlertAt = 0;
}

/** Read the plugin's client directly for assertion purposes. */
function pluginClient(): unknown {
  return (brokerRegistry.getPlugin("tradovate") as TradovateBrokerPlugin).getClient();
}

/** Read the plugin's last-alert timestamp for assertion/seeding purposes. */
function setPluginLastAlertAt(at: number): void {
  const plugin = brokerRegistry.getPlugin("tradovate") as unknown as Record<string, unknown>;
  plugin.lastTradovateAuthAlertAt = at;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetGlobalState();
});

// Fix 1a: client instance is preserved across auth failures *after* first success
describe("getTradovateClientIfConfigured — client preserved on auth failure (post-first-success)", () => {
  it("client instance survives an auth failure once it has previously authenticated", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    // First call: authenticate succeeds — client is created and stored
    const firstResult = await getTradovateClientIfConfigured();
    expect(firstResult).toBeInstanceOf(TradovateClient);

    const storedClient = firstResult;

    // Second call: authenticate throws (via the shared module-level mock)
    mockAuthenticate.mockRejectedValueOnce(new Error("auth failed"));
    const secondResult = await getTradovateClientIfConfigured();

    // Post-first-success behavior: getClient() still returns the same
    // instance (PenaltyResponseHandler state is preserved across the
    // failure). Wrapper returns the same client.
    expect(secondResult).toBe(storedClient);
    expect(pluginClient()).toBe(storedClient);
  });

  it("client is nulled when creds are removed from DB", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    await getTradovateClientIfConfigured(); // create the client
    expect(pluginClient()).not.toBeNull();

    // Now creds disappear
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    const result = await getTradovateClientIfConfigured();

    expect(result).toBeNull();
    expect(pluginClient()).toBeNull();
  });
});

// Fix 1b: Discord alert fires once on first auth failure
describe("getTradovateClientIfConfigured — Discord alert throttling", () => {
  it("Discord alert fires on first auth failure when Tradovate is expected", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);

    // First call: authenticate succeeds — no alert
    await getTradovateClientIfConfigured();
    expect(mockSendDiscordAlert).not.toHaveBeenCalled();

    // Second call: auth fails
    mockAuthenticate.mockRejectedValueOnce(new Error("timeout"));
    await getTradovateClientIfConfigured();

    expect(mockSendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("Discord alert is suppressed on second auth failure within the 5-minute window", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);

    // First call succeeds — stores client
    await getTradovateClientIfConfigured();

    // Seed the alert timestamp as if an alert just fired (now - 1 second)
    setPluginLastAlertAt(Date.now() - 1000);

    // Auth failure: within suppression window
    mockAuthenticate.mockRejectedValueOnce(new Error("fail"));
    await getTradovateClientIfConfigured();

    // Alert was within the 5-min window — must NOT fire
    expect(mockSendDiscordAlert).not.toHaveBeenCalled();
  });

  it("Discord alert fires again after the 5-minute suppression window expires", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);

    // First call succeeds
    await getTradovateClientIfConfigured();

    // Seed the alert timestamp as if the last alert was 6 minutes ago
    const SIX_MINUTES_MS = 6 * 60 * 1000;
    setPluginLastAlertAt(Date.now() - SIX_MINUTES_MS);

    mockAuthenticate.mockRejectedValueOnce(new Error("fail"));
    await getTradovateClientIfConfigured();

    // 6 min > suppression window → alert should fire
    expect(mockSendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("Discord alert is NOT sent when BrokerRegistry.tradovateExpected returns false", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(false);

    // isExpected() short-circuits initialize() to a no-op when false, so
    // no client is created and no auth attempt runs at all → no alert.
    await getTradovateClientIfConfigured();
    mockAuthenticate.mockRejectedValueOnce(new Error("fail"));
    await getTradovateClientIfConfigured();

    expect(mockSendDiscordAlert).not.toHaveBeenCalled();
  });
});

describe("getTradovateClientIfConfigured — returns null on first auth fail", () => {
  it("returns null without throwing when authenticate rejects on a fresh client (never authenticated)", async () => {
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u", password: "p" } as never);
    vi.mocked(BrokerRegistry.tradovateExpected).mockReturnValue(true);

    // Shared authenticate mock rejects on the very first call (no prior success)
    mockAuthenticate.mockRejectedValueOnce(new Error("network error"));

    const result = await getTradovateClientIfConfigured();

    // Function must return null, not throw — downstream callers
    // (positions/route, boot-engine, flatten-all, engine.ts) treat null
    // as "Tradovate unavailable → auto-pause". Preserving an
    // unauthenticated client here would silently break that contract.
    expect(result).toBeNull();
    expect(pluginClient()).toBeNull();
  });
});

describe("getLogsByLevel — what leaves the process", () => {
  /** Seed the rings directly; `logRings()` returns an existing global as-is. */
  function seedRings(logs: RingLogEntry[], heartbeatLogs: RingLogEntry[] = []): void {
    (globalThis as Record<string, unknown>)[RINGS_KEY] = { logs, heartbeatLogs };
  }

  const FULL: RingLogEntry = {
    timestamp: "2026-08-27T00:00:00.000Z",
    deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
    level: "error",
    message: "residual position after exit",
    severity: "error",
    category: "safety",
    event: "exit_verification_residual",
    display: "…4469-ema-crossover.MNQ",
    accountId: 12344469,
    contractId: "CON.F.US.MNQ.U26",
    tradeId: 8812,
    burstKey: "abc|d1|",
    burstCount: 3,
    lastSeenAt: "2026-08-27T00:00:20.000Z",
  };

  it("serialises a ring record carrying a full account id without it", () => {
    seedRings([FULL]);
    const json = JSON.stringify(getLogsByLevel(100));
    expect(json).toContain("…4469-ema-crossover.MNQ");
    expect(json).not.toContain("12344469");
    expect(json).not.toContain("CON.F.US.MNQ.U26");
  });

  it("keeps the four legacy fields plus the envelope the viewer is owed", () => {
    seedRings([FULL]);
    expect(getLogsByLevel(100).error[0]).toEqual({
      timestamp: FULL.timestamp,
      deploymentId: FULL.deploymentId,
      level: "error",
      message: FULL.message,
      severity: "error",
      category: "safety",
      event: "exit_verification_residual",
      display: "…4469-ema-crossover.MNQ",
      // The rendered symbol, for a line that names a contract and no
      // deployment. Null here: this one has a display, whose last segment is
      // already the ticker.
      ticker: null,
      // The one structural id L4b added, because the Activity lane's
      // episode card is a `trade_id` group. The account and the contract
      // stay behind, which is what the assertion above is for.
      tradeId: 8812,
      // The template's value slots. Null on a line that named none, which
      // is every line outside the trade spine.
      values: null,
      burstCount: 3,
      // The ring index, stamped here because this is the last place the
      // emission order exists — the payload is bucketed per level and the
      // client merges it back on `(timestamp, seq)`.
      seq: 0,
    });
  });

  it("stamps the ring index so a same-millisecond pair keeps its emission order", () => {
    const second: RingLogEntry = { ...FULL, level: "info", message: "the line after it" };
    seedRings([FULL, second]);
    const out = getLogsByLevel(100);
    expect(out.error[0].seq).toBe(0);
    expect(out.info[0].seq).toBe(1);
  });

  it("offsets the heartbeat ring's ordinals past the main ring's", () => {
    seedRings([FULL], [{ ...FULL, level: "heartbeat", category: "heartbeat" }]);
    const out = getLogsByLevel(100);
    expect(out.error[0].seq).toBe(0);
    expect(out.heartbeat[0].seq).toBe(1);
  });

  it("projects the heartbeat ring too", () => {
    seedRings([], [{ ...FULL, level: "heartbeat", category: "heartbeat" }]);
    expect(JSON.stringify(getLogsByLevel(100))).not.toContain("12344469");
  });
});

/**
 * The ring half of burst collapse, through the **real** pipe and the real
 * accessor — importing this module is what registers its ring sink, so the
 * routing under test is the production one.
 *
 * The gap being closed: the fold's count reached `engine_logs.burst_count`
 * and nothing else, while `/logs` polls the rings on a 5s timer. A climbing
 * `error` row was therefore silent escalation until the next restart
 * hydrated its count back.
 */
describe("a folded burst on the live ring", () => {
  const LINE = "Bracket cancel failed for order 8811001";
  let storeBumps: BurstUpdate[];
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  const rings = logRings;

  /** An engine line: the pipe returns the record and the engine's own log
   *  handler is what puts it on a ring. Standing in for that handler here
   *  keeps the fold path — the thing under test — production-real. */
  function engineLine(message: string): void {
    const record = emit({
      event: null,
      severity: "error",
      category: "safety",
      deploymentId: "d1",
      message,
    });
    if (record) rings().logs.push(record);
  }

  beforeEach(() => {
    storeBumps = [];
    setLogSink({ write: () => {}, bump: (u) => void storeBumps.push(u) });
    // Process-wide window state: a message this file emitted in an earlier
    // test folds into that test's window otherwise. See patterns.md.
    resetLogBursts();
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    setLogSink(null);
    resetLogBursts();
    for (const spy of consoleSpies) spy.mockRestore();
  });

  it("climbs the count the /logs poll reads, with no restart in between", () => {
    engineLine(LINE);
    engineLine(LINE);
    engineLine(LINE);
    expect(rings().logs).toHaveLength(1);
    expect(getLogsByLevel(100).error[0].burstCount).toBe(3);
  });

  it("leaves the ring's length and order alone — the entry is updated in place", () => {
    engineLine("first, and not part of the burst");
    engineLine(LINE);
    engineLine(LINE);
    expect(rings().logs).toHaveLength(2);
    expect(rings().logs[0].message).toBe("first, and not part of the burst");
    expect(rings().logs[1].burstCount).toBe(2);
  });

  it("agrees with the durable row on the final count", () => {
    for (let i = 0; i < 23; i++) engineLine(LINE);
    expect(storeBumps[storeBumps.length - 1].count).toBe(23);
    expect(rings().logs[0].burstCount).toBe(storeBumps[storeBumps.length - 1].count);
    expect(rings().logs[0].burstKey).toBe(storeBumps[storeBumps.length - 1].burstKey);
  });

  // The L1 review's attack: the window outlives the ring entry it named.
  it("does not resurrect or throw when its ring entry was evicted mid-window", () => {
    engineLine(LINE);
    rings().logs.shift();
    expect(() => engineLine(LINE)).not.toThrow();
    expect(rings().logs).toHaveLength(0);
    // The durable row still counts — only the live surface was lost.
    expect(storeBumps[storeBumps.length - 1].count).toBe(2);
  });

  it("matches on the cause key, not on a shared timestamp", () => {
    engineLine(LINE);
    const neighbour: RingLogEntry = {
      ...rings().logs[0],
      message: "another line, same millisecond",
      burstKey: "|deadbeef|d1|",
      burstCount: 1,
    };
    rings().logs.push(neighbour);
    engineLine(LINE);
    expect(neighbour.burstCount).toBe(1);
    expect(rings().logs[0].burstCount).toBe(2);
  });

  it("leaves the heartbeat ring alone, because a heartbeat never folds", () => {
    for (let i = 0; i < 3; i++) {
      const record = emit({
        event: null,
        severity: "info",
        category: "heartbeat",
        deploymentId: "engine",
        message: "[heartbeat] 1 deployment",
      });
      expect(record).not.toBeNull();
      rings().heartbeatLogs.push(record!);
    }
    expect(storeBumps).toHaveLength(0);
    expect(getLogsByLevel(100).heartbeat.map((e) => e.burstCount)).toEqual([1, 1, 1]);
  });
});

/**
 * The boot window: `log.*` lines are emitted before any engine exists, so
 * the engine's log handler is not what carries them. Importing this module
 * registers the pipe's ring sink, which is what does — and what makes the
 * staging boot's `[info]` lines visible in `/logs` without waiting for the
 * next restart's hydration.
 */
describe("a tagged line reaches the rings before any engine exists", () => {
  const BOOT_LINE = "boot: configured brokers — topstep, tradovate";
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  function ring(): RingLogEntry[] {
    return logRings().logs;
  }

  beforeEach(() => {
    H.hydrateRings.mockReturnValue({ main: [], heartbeat: [] });
    H.hydrateRings.mockClear();
    resetLogBursts();
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    resetLogBursts();
    for (const spy of consoleSpies) spy.mockRestore();
  });

  it("is visible through the real accessor with no engine constructed", () => {
    consoleLog("info", "engine", BOOT_LINE);
    expect(getEngineIfReady()).toBeNull();
    expect(getLogsByLevel(100).info.map((e) => e.message)).toEqual([BOOT_LINE]);
  });

  it("carries the envelope the viewer reads, not just the four legacy fields", () => {
    consoleLog("warn", "tradovate.realtime", "fill not in order map");
    expect(getLogsByLevel(100).warn[0]).toMatchObject({
      severity: "warn",
      category: "broker",
      deploymentId: "engine",
      burstCount: 1,
    });
  });

  it("lands in the main ring and never in the heartbeat one", () => {
    consoleLog("info", "engine", BOOT_LINE);
    expect(ring()).toHaveLength(1);
    expect(getLogsByLevel(100).heartbeat).toEqual([]);
  });

  it("counts a folded repeat on the entry it pushed", () => {
    consoleLog("warn", "flatten-all", "close failed on account 11444469");
    consoleLog("warn", "flatten-all", "close failed on account 11444469");
    expect(getLogsByLevel(100).warn.map((e) => e.burstCount)).toEqual([2]);
  });

  // The hazard this ordering closes: hydration used to be gated on "are the
  // rings empty", and a boot line now lands on them before `getEngine()`
  // runs — so every boot would have skipped hydration entirely.
  it("still hydrates a restart's rows, and puts them in front of the boot lines", async () => {
    const older: LegacyLogEntry = {
      timestamp: "2026-08-26T23:00:00.000Z",
      deploymentId: "engine",
      level: "info",
      message: "a line from the process before this one",
    };
    H.hydrateRings.mockReturnValue({ main: [older], heartbeat: [] });
    consoleLog("info", "engine", BOOT_LINE);
    await getEngine();
    expect(H.hydrateRings).toHaveBeenCalledTimes(1);
    expect(getLogsBuffer().map((e) => e.message)).toEqual([older.message, BOOT_LINE]);
  });

  it("hydrates once per process, however many times the engine is asked for", async () => {
    await getEngine();
    await getEngine();
    expect(H.hydrateRings).toHaveBeenCalledTimes(1);
  });
});

describe("a web-role process never builds an engine", () => {
  // `getEngine()` builds and starts an engine wherever it is called, so a web
  // process refuses at the door rather than at `start()`: by then the hubs
  // are open on the broker login the engine process is using.
  const originalRole = process.env.CROSSFIRE_ROLE;

  beforeEach(() => {
    process.env.CROSSFIRE_ROLE = "web";
    LEASE.reportLeaseRefused.mockClear();
    BOOT.runBootSequence.mockClear();
    H.hydrateRings.mockClear();
  });

  afterEach(() => {
    if (originalRole === undefined) delete process.env.CROSSFIRE_ROLE;
    else process.env.CROSSFIRE_ROLE = originalRole;
  });

  it("throws the typed error from getEngine() and constructs nothing", async () => {
    await expect(getEngine()).rejects.toMatchObject({ name: "EngineNotInThisProcessError" });
    expect(getEngineIfReady()).toBeNull();
    expect(H.hydrateRings).not.toHaveBeenCalled();
    expect(LEASE.reportLeaseRefused).toHaveBeenCalledWith("getEngine()", expect.any(String));
  });

  it("throws from activateFromSettings() without running the boot sequence", async () => {
    await expect(activateFromSettings()).rejects.toMatchObject({
      name: "EngineNotInThisProcessError",
    });
    expect(BOOT.runBootSequence).not.toHaveBeenCalled();
    expect(LEASE.reportLeaseRefused).toHaveBeenCalledWith(
      "activateFromSettings()",
      expect.any(String),
    );
  });

  it("still builds one in the default role", async () => {
    delete process.env.CROSSFIRE_ROLE;
    const engine = await getEngine();
    expect(getEngineIfReady()).toBe(engine);
    expect(LEASE.reportLeaseRefused).not.toHaveBeenCalled();
  });
});

describe("an engine-role process without the lease builds nothing", () => {
  // A boot refused at the lease bound leaves the process serving, and any
  // route reaching `getEngine()` would build an engine whose plugins log in
  // and open hubs on the session the live engine uses.
  beforeEach(() => {
    LEASE.held = false;
    LEASE.reportLeaseRefused.mockClear();
    H.hydrateRings.mockClear();
  });

  afterEach(() => {
    LEASE.held = true;
    vi.restoreAllMocks();
  });

  it("throws the typed error, constructs no engine and initialises no broker", async () => {
    const inits = brokerRegistry.allPlugins().map((p) => vi.spyOn(p, "initialize"));

    await expect(getEngine()).rejects.toMatchObject({ name: "EngineNotInThisProcessError" });

    expect(getEngineIfReady()).toBeNull();
    expect(H.hydrateRings).not.toHaveBeenCalled();
    for (const init of inits) expect(init).not.toHaveBeenCalled();
    expect(LEASE.reportLeaseRefused).toHaveBeenCalledWith("getEngine()", expect.any(String));
  });

  it("still returns an engine built while it held the lease", async () => {
    LEASE.held = true;
    const engine = await getEngine();
    LEASE.held = false;

    await expect(getEngine()).resolves.toBe(engine);
    expect(LEASE.reportLeaseRefused).not.toHaveBeenCalled();
  });
});
