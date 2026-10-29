/**
 * `attemptUserReconnect`'s `Connected` bail, and the one trigger that is
 * allowed past it.
 *
 * The bail reads a hub reporting `Connected` as "it healed itself, via
 * SignalR's automatic reconnect" and returns without doing anything. That
 * inference is right for every trigger but one: a Topstep session is bound
 * to the token that opened the socket, so `/Auth/validate` rotating the
 * bearer retires the session while the WebSocket stays open and the hub goes
 * on reporting `Connected`. It streams nothing from that moment, and fill
 * detection — entry and exit reconciliation — is what stops.
 *
 * That is the half of A3 (docs/bugs.md) that the entry did not name and that
 * the 120s stall watchdog cannot cover: the watchdog is the market hub's, and
 * the user hub's own anomaly trigger is `userState !== "Connected"`, which a
 * retired session never satisfies. Without the carve-out below, nothing in
 * the engine ever reconnects that hub.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const { validateOrRefreshToken } = vi.hoisted(() => ({
  validateOrRefreshToken: vi.fn(async () => "validated-token"),
}));

vi.mock("@/lib/brokers/topstep/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/brokers/topstep/auth")>()),
  validateOrRefreshToken,
}));

import { TradingEngine, type EngineLog } from "./engine";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { TopstepRealtimeAdapter } from "@/lib/brokers/topstep/realtime-adapter";
import type { TopstepUserHubTransport } from "@/lib/brokers/topstep/user-hub";
import type { TopstepSignalR } from "@/lib/brokers/topstep/signalr";
import type { Deployment } from "@/lib/trading/domain";
import { resetLogBursts, type LogRecord } from "@/lib/logging/pipe";
import { MarketHubController, type MarketHubDeps } from "./engine-market-hub";

type UserHubTrigger = "auto-heal" | "heartbeat" | "token-rotation";

type EnginePrivates = {
  attemptUserReconnect(trigger: UserHubTrigger): Promise<boolean>;
  signalr: unknown;
  topstepRealtime: {
    hubState(): string;
    forceReconnect(): Promise<void>;
    liveness?(): { lastEventAt: number; windowCount: number; hubStarted: boolean };
  } | null;
  userReconnectFailures: number;
  userRotationPending: boolean;
  userHandoffInFlight: boolean;
  marketHub: MarketHubController;
};

/** Mirrors the engine's private constant; the cap tests are about the
 *  counter reaching it, not about its value. */
const USER_RECONNECT_MAX_FAILURES = 3;

function makeHarness(hubState: string) {
  const topstepClient = new TopstepClient("http://localhost:0");
  const engine = new TradingEngine(
    topstepClient,
    new TradovateClient("http://localhost:0"),
    null,
  );
  const priv = engine as unknown as EnginePrivates;
  const logs: EngineLog[] = [];
  const records: LogRecord[] = [];
  engine.setLogHandler((entry) => {
    logs.push(entry);
    records.push(entry);
  });

  const forceReconnect = vi.fn(async () => {});
  // `signalr` only has to be present — `attemptUserReconnect` reads nothing
  // off it, it just refuses to run when realtime is switched off entirely.
  priv.signalr = {};
  priv.topstepRealtime = { hubState: () => hubState, forceReconnect };

  return { engine, priv, logs, records, forceReconnect, topstepClient };
}

/**
 * The prod shape of A79: the gateway accepts the handshake, `start()`
 * resolves, and the socket closes before the account subscribes land — each
 * one cancelled with the connection. Everything but the socket is the
 * shipped adapter.
 */
class InstantCloseHub implements TopstepUserHubTransport {
  closeOnSubscribe = false;
  private closeHandler: ((err?: Error) => void) | null = null;
  build(): void {
    this.closeHandler = null;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  state(): string {
    return this.closeOnSubscribe ? "Disconnected" : "Connected";
  }
  onOrder(): void {}
  onPosition(): void {}
  onUserTrade(): void {}
  onReconnected(): void {}
  onReconnecting(): void {}
  onClose(h: (err?: Error) => void): void {
    this.closeHandler = h;
  }
  onGatewayLogout(): void {}
  async subscribeAccount(): Promise<void> {
    if (!this.closeOnSubscribe) return;
    this.closeHandler?.();
    throw new Error("Invocation canceled due to the underlying connection being closed.");
  }
  async unsubscribeAccount(): Promise<void> {}
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLogBursts();
});

describe("attemptUserReconnect", () => {
  it("reconnects a hub reporting Connected when the trigger is a token rotation", async () => {
    const { priv, forceReconnect } = makeHarness("Connected");
    await expect(priv.attemptUserReconnect("token-rotation")).resolves.toBe(true);
    expect(forceReconnect).toHaveBeenCalledTimes(1);
  });

  it("leaves a hub reporting Connected alone on every other trigger", async () => {
    // The bail is right here and must stay: SignalR's own automatic
    // reconnect heals most outages, and fighting a healthy hub every
    // heartbeat is what the rate limit above it exists to prevent.
    for (const trigger of ["heartbeat", "auto-heal"] as const) {
      const { priv, forceReconnect } = makeHarness("Connected");
      await expect(priv.attemptUserReconnect(trigger)).resolves.toBe(false);
      expect(forceReconnect).not.toHaveBeenCalled();
    }
  });

  it("clears the failure counter on the Connected bail, and the carve-out does not", async () => {
    // The bail's second job. A rotation-triggered reconnect is a real
    // attempt, so it must go through the counter rather than resetting it
    // on the way past — otherwise a genuinely displaced session never
    // reaches `USER_RECONNECT_MAX_FAILURES` and never gives up.
    const healed = makeHarness("Connected");
    healed.priv.userReconnectFailures = 2;
    await healed.priv.attemptUserReconnect("heartbeat");
    expect(healed.priv.userReconnectFailures).toBe(0);

    const rotated = makeHarness("Connected");
    rotated.priv.userReconnectFailures = 2;
    rotated.forceReconnect.mockRejectedValueOnce(new Error("session displaced"));
    await rotated.priv.attemptUserReconnect("token-rotation");
    expect(rotated.priv.userReconnectFailures).toBe(3);
  });

  it("still reconnects a hub that reports a bad state, on any trigger", async () => {
    const { priv, forceReconnect } = makeHarness("Disconnected");
    await expect(priv.attemptUserReconnect("heartbeat")).resolves.toBe(true);
    expect(forceReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("attemptUserReconnect — A79", () => {
  it("refreshes the token onto the client before rebuilding the hub", async () => {
    const order: string[] = [];
    const { priv, forceReconnect, topstepClient } = makeHarness("Disconnected");
    validateOrRefreshToken.mockImplementation(async () => {
      order.push("validate");
      return "validated-token";
    });
    forceReconnect.mockImplementation(async () => {
      order.push(`forceReconnect:${topstepClient.getToken()}`);
    });

    for (const trigger of ["heartbeat", "auto-heal"] as const) {
      order.length = 0;
      await priv.attemptUserReconnect(trigger);
      expect(order).toEqual(["validate", "forceReconnect:validated-token"]);
    }
  });

  it("does not re-validate on a token rotation, whose fresh token is already on the client", async () => {
    const { priv, forceReconnect } = makeHarness("Connected");
    await priv.attemptUserReconnect("token-rotation");
    expect(validateOrRefreshToken).not.toHaveBeenCalled();
    expect(forceReconnect).toHaveBeenCalledTimes(1);
  });

  it("counts a failed token refresh as a failed attempt without touching the hub", async () => {
    const { priv, forceReconnect } = makeHarness("Disconnected");
    validateOrRefreshToken.mockRejectedValueOnce(new Error("loginKey refused"));
    await priv.attemptUserReconnect("heartbeat");
    expect(forceReconnect).not.toHaveBeenCalled();
    expect(priv.userReconnectFailures).toBe(1);
  });

  it("counts a start that closes before its subscriptions land as a failure, and never logs it as reconnected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { priv, records } = makeHarness("Disconnected");
    const transport = new InstantCloseHub();
    const adapter = new TopstepRealtimeAdapter(transport, () => null);
    await adapter.sync(new Set([1001]));
    priv.topstepRealtime = adapter;

    transport.closeOnSubscribe = true;
    await expect(priv.attemptUserReconnect("heartbeat")).resolves.toBe(true);

    expect(priv.userReconnectFailures).toBe(1);
    expect(records.map((r) => r.event)).toContain("hub_reconnect_failed");
    expect(records.map((r) => r.event)).not.toContain("hub_reconnected");

    adapter.shutdown();
    warn.mockRestore();
  });

  it("reaches the give-up cap on repeated instant closes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { priv, records } = makeHarness("Disconnected");
    const transport = new InstantCloseHub();
    const adapter = new TopstepRealtimeAdapter(transport, () => null);
    await adapter.sync(new Set([1001]));
    priv.topstepRealtime = adapter;
    transport.closeOnSubscribe = true;

    for (let i = 0; i < 3; i++) await priv.attemptUserReconnect("heartbeat");

    expect(priv.userReconnectFailures).toBe(3);
    expect(records.map((r) => r.event)).toContain("hub_reconnect_abandoned");

    adapter.shutdown();
    warn.mockRestore();
  });
});

/**
 * The pre-reconnect validate can itself rotate the token, which retires the
 * market hub's session as well as the user hub's. The engine's own market-hub
 * controller is rebuilt here over a fake socket and the engine's real deps,
 * so the rotation runs the shipped path end to end: the heartbeat noticing it
 * 30s later was the gap, and its `token-rotation` call bouncing off an
 * in-flight attempt was the drop.
 */
describe("attemptUserReconnect — A79 rotation under a reconnect", () => {
  function fakeMarketSignalr() {
    return {
      buildMarketHub: vi.fn(),
      startMarketHub: vi.fn(async () => {}),
      disconnectMarket: vi.fn(async () => {}),
      onTrade: vi.fn(),
      onMarketReconnected: vi.fn(),
      onMarketGatewayLogout: vi.fn(),
      onMarketClose: vi.fn(),
      getMarketHubState: vi.fn(() => "Connected"),
    };
  }

  /** A market hub opened on `tok-a`, then `mints` for each later validate. */
  async function rotationHarness(...mints: string[]) {
    const h = makeHarness("Disconnected");
    let userState = "Disconnected";
    const tokensAtForce: (string | null)[] = [];
    h.forceReconnect.mockImplementation(async () => {
      tokensAtForce.push(h.topstepClient.getToken());
      userState = "Connected";
    });
    h.priv.topstepRealtime = {
      hubState: () => userState,
      forceReconnect: h.forceReconnect,
      liveness: () => ({ lastEventAt: 0, windowCount: 0, hubStarted: true }),
    };
    const signalr = fakeMarketSignalr();
    const deps = (h.priv.marketHub as unknown as { deps: MarketHubDeps }).deps;
    // The heartbeat reaches its user-hub check only with an active
    // deployment; the engine's set is empty here, so a test can supply one.
    let deployments: Deployment[] = [];
    h.priv.marketHub = new MarketHubController(signalr as unknown as TopstepSignalR, {
      ...deps,
      realtimeDeployments: () => deployments,
    });

    const queue = ["tok-a", ...mints];
    validateOrRefreshToken.mockImplementation(async () => queue.shift() ?? mints[mints.length - 1]);
    await h.priv.marketHub.connect();
    signalr.disconnectMarket.mockClear();
    signalr.buildMarketHub.mockClear();
    validateOrRefreshToken.mockClear();
    return {
      ...h,
      signalr,
      tokensAtForce,
      setDeployments: (next: Deployment[]) => {
        deployments = next;
      },
    };
  }

  it("A79: a heartbeat landing mid-hand-off does not start a second user-hub rebuild", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
    try {
      const h = await rotationHarness("tok-b");
      h.setDeployments([{ id: "d1", accountId: 1001, status: "Active" } as Deployment]);
      let release: () => void = () => {};
      h.signalr.startMarketHub.mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = resolve)),
      );

      const attempt = h.priv.attemptUserReconnect("heartbeat");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.signalr.disconnectMarket).toHaveBeenCalledTimes(1);

      // The rebuild is parked on the market hub's start; the user hub still
      // reports Disconnected, so the heartbeat's anomaly check fires.
      h.priv.marketHub.startHeartbeat();
      await vi.advanceTimersByTimeAsync(35_000);
      h.priv.marketHub.stopHeartbeat();
      expect(h.records.some((r) => r.event === "user_hub_degraded")).toBe(true);

      release();
      await expect(attempt).resolves.toBe(true);

      expect(h.signalr.disconnectMarket).toHaveBeenCalledTimes(1);
      expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
      expect(h.forceReconnect).toHaveBeenCalledTimes(1);
      expect(h.records.filter((r) => r.event === "hub_token_rotated")).toHaveLength(1);
      h.priv.marketHub.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("A79: at the failure cap no attempt validates, so none hands off", async () => {
    const h = await rotationHarness("tok-b");
    h.priv.userReconnectFailures = USER_RECONNECT_MAX_FAILURES;

    await expect(h.priv.attemptUserReconnect("heartbeat")).resolves.toBe(false);

    expect(validateOrRefreshToken).not.toHaveBeenCalled();
    expect(h.signalr.disconnectMarket).not.toHaveBeenCalled();
    expect(h.forceReconnect).not.toHaveBeenCalled();
    h.priv.marketHub.shutdown();
  });

  it("A79: a hand-off one short of the cap restarts the count, and a failed user leg still clears the guard", async () => {
    // The market rebuild's `connect()` → `exitPassiveMode` →
    // `cancelMaintenanceHeal` resets the user counter, as every market-hub
    // connect already did. So the rotation leg is attempt #1, not the one
    // that trips the cap — pinned here rather than left implicit.
    const h = await rotationHarness("tok-b");
    h.priv.userReconnectFailures = USER_RECONNECT_MAX_FAILURES - 1;
    h.forceReconnect.mockRejectedValueOnce(new Error("session displaced"));

    await expect(h.priv.attemptUserReconnect("heartbeat")).resolves.toBe(true);

    expect(h.signalr.disconnectMarket).toHaveBeenCalledTimes(1);
    expect(h.forceReconnect).toHaveBeenCalledTimes(1);
    expect(h.priv.userReconnectFailures).toBe(1);
    expect(h.records.map((r) => r.event)).not.toContain("hub_reconnect_abandoned");
    expect(h.priv.userHandoffInFlight).toBe(false);
    h.priv.marketHub.shutdown();
  });

  it("A79: a pre-reconnect validate that rotates the token rebuilds both hubs in the same attempt", async () => {
    const h = await rotationHarness("tok-b");

    await expect(h.priv.attemptUserReconnect("heartbeat")).resolves.toBe(true);

    expect(h.signalr.disconnectMarket).toHaveBeenCalledTimes(1);
    expect(h.signalr.buildMarketHub).toHaveBeenCalledTimes(1);
    expect(h.records.filter((r) => r.event === "hub_token_rotated")).toHaveLength(1);
    // One user-hub rebuild, on the rotated token — not one before the market
    // hub moved and another after.
    expect(h.tokensAtForce).toEqual(["tok-b"]);
    expect(h.priv.marketHub.tokenMovedUnderHubs()).toBe(false);
    h.priv.marketHub.shutdown();
  });

  it("A79: the token-rotation leg never validates, and a rebuild whose own validate rotates again does not re-fire", async () => {
    vi.useFakeTimers();
    // Wednesday 14:00 ET — outside every maintenance window, or the
    // heartbeat body returns before its rotation check.
    vi.setSystemTime(new Date("2026-08-26T18:00:00Z"));
    try {
      const h = await rotationHarness("tok-b", "tok-c");

      await h.priv.attemptUserReconnect("heartbeat");
      // The attempt's validate, then the market rebuild's `connect()` — and
      // nothing from the `token-rotation` leg that followed.
      expect(validateOrRefreshToken).toHaveBeenCalledTimes(2);
      expect(h.topstepClient.getToken()).toBe("tok-c");
      expect(h.tokensAtForce).toEqual(["tok-c"]);

      h.priv.marketHub.startHeartbeat();
      await vi.advanceTimersByTimeAsync(90_000);
      h.priv.marketHub.stopHeartbeat();

      expect(h.records.filter((r) => r.event === "hub_token_rotated")).toHaveLength(1);
      expect(h.forceReconnect).toHaveBeenCalledTimes(1);
      h.priv.marketHub.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("A79: a rotation arriving while a user reconnect is in flight is honoured after it, once", async () => {
    const { priv, forceReconnect } = makeHarness("Disconnected");
    validateOrRefreshToken.mockImplementation(async () => "validated-token");
    let release: () => void = () => {};
    forceReconnect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const inFlight = priv.attemptUserReconnect("heartbeat");
    await vi.waitFor(() => expect(forceReconnect).toHaveBeenCalledTimes(1));

    await expect(priv.attemptUserReconnect("token-rotation")).resolves.toBe(false);
    await expect(priv.attemptUserReconnect("token-rotation")).resolves.toBe(false);
    expect(forceReconnect).toHaveBeenCalledTimes(1);

    release();
    await expect(inFlight).resolves.toBe(true);

    expect(forceReconnect).toHaveBeenCalledTimes(2);
    expect(validateOrRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("A79: a pending rotation drained after a failed attempt that hit the cap returns silently", async () => {
    const { priv, forceReconnect, records } = makeHarness("Disconnected");
    validateOrRefreshToken.mockImplementation(async () => "validated-token");
    priv.userReconnectFailures = USER_RECONNECT_MAX_FAILURES - 1;
    let fail: (err: Error) => void = () => {};
    forceReconnect.mockImplementationOnce(
      () => new Promise<void>((_, reject) => (fail = reject)),
    );

    const inFlight = priv.attemptUserReconnect("heartbeat");
    await vi.waitFor(() => expect(forceReconnect).toHaveBeenCalledTimes(1));
    await expect(priv.attemptUserReconnect("token-rotation")).resolves.toBe(false);

    fail(new Error("session displaced"));
    await expect(inFlight).resolves.toBe(true);

    expect(priv.userReconnectFailures).toBe(USER_RECONNECT_MAX_FAILURES);
    expect(forceReconnect).toHaveBeenCalledTimes(1);
    expect(records.filter((r) => r.event === "hub_reconnecting")).toHaveLength(1);
    expect(priv.userRotationPending).toBe(false);
  });
});
