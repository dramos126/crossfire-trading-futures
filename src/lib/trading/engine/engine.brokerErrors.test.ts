/**
 * Tests for the engine's broker-error control flow — Phase E5's
 * `instanceof` → taxonomy conversion.
 *
 * These two decisions are the ones a mis-mapped kind changes silently:
 * `maybeOrphanFromBrokerError` pauses every deployment on an account, and
 * `isEngineFatalAuthError` stops the whole engine. Both go through the
 * *real* plugins' `ownsError` / `classifyError`, so a plugin that
 * reclassifies one of its error classes fails here rather than in
 * production.
 *
 * Access pattern: (engine as any).maybeOrphanFromBrokerError(err, acct).
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

// `BrokerKind` is a string `const enum`, which transpiles to a runtime
// object rather than being inlined — the engine narrows `plugin.id`
// through it to key the orphan-reason table, so the mock has to carry it.
// The two values are frozen (they are the persisted `account_brokers.broker`
// column); see docs/modules/brokers/README.md.
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
  setTopstepUsername: vi.fn(),
  setTopstepApiKey: vi.fn(),
  setTradovateApiCid: vi.fn(),
  setTradovateApiSecret: vi.fn(),
  setTradovateAppId: vi.fn(),
  setTradovateAppVersion: vi.fn(),
  setTradovateDeviceId: vi.fn(),
  setTradovatePassword: vi.fn(),
  setTradovateUsername: vi.fn(),
}));

vi.mock("@/lib/db/settings-cache", () => ({
  resolveTopstepUsername: vi.fn().mockReturnValue(null),
  resolveTopstepApiKey: vi.fn().mockReturnValue(null),
  resolveTopstepWebhookUrl: vi.fn().mockReturnValue(null),
  invalidateSettingsCache: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("@/lib/db/auth", () => ({
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

import { TradingEngine } from "./engine";
import { TopstepClient, AccountNotFoundError, UnauthorizedError } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import { TopstepBrokerPlugin } from "@/lib/brokers/topstep";
import { TradovateBrokerPlugin } from "@/lib/brokers/tradovate";
import { BrokerRegistry } from "@/lib/brokers/registry";
import {
  TradovateAccountNotActiveError,
  TradovateAuthPenaltyError,
  TradovateCaptchaLockoutError,
  TradovateCircuitOpenError,
  TradovateOrderRejectionError,
  TradovateUnauthorizedError,
} from "@/lib/brokers/tradovate/errors";
import { markOrphanedByAccount } from "@/lib/db/deployments";
import { resetLogBursts } from "@/lib/logging/pipe";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FALLBACK_ACCOUNT = 5150;

function makeEngine(): TradingEngine {
  const registry = new BrokerRegistry();
  registry.register(new TopstepBrokerPlugin());
  registry.register(new TradovateBrokerPlugin());

  const topstepClient = new TopstepClient("http://localhost:0");
  const tradovateClient = new TradovateClient("http://localhost:0");
  (tradovateClient as unknown as Record<string, unknown>).getDatedSymbolForContractId =
    vi.fn().mockReturnValue(null);
  (tradovateClient as unknown as Record<string, unknown>).warmContractId =
    vi.fn().mockResolvedValue(undefined);

  return new TradingEngine(topstepClient, tradovateClient, null, registry);
}

/**
 * `(engine as any)` once, in one place, rather than at every call site.
 *
 * `nakedWatchdog.deps` is here so the *wired* `rejectionProvesTerminal` can be
 * called rather than re-formed in the test: the expression is the subject, so a
 * copy of it would assert the copy.
 */
type EnginePrivates = {
  maybeOrphanFromBrokerError(err: unknown, fallbackAccountId: number): void;
  isEngineFatalAuthError(err: unknown): boolean;
  nakedWatchdog: { deps: { rejectionProvesTerminal(err: unknown): boolean } };
};

function priv(engine: TradingEngine): EnginePrivates {
  return engine as unknown as EnginePrivates;
}

const orphanCalls = () => vi.mocked(markOrphanedByAccount).mock.calls;

beforeEach(() => {
  vi.mocked(markOrphanedByAccount).mockClear();
});

// ── maybeOrphanFromBrokerError ────────────────────────────────────────────────

describe("maybeOrphanFromBrokerError — orphan-pausing kinds", () => {
  it("Topstep AccountNotFound pauses with the legacy reason and the error's own accountId", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new AccountNotFoundError(4242),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([[4242, "place_order_account_not_found"]]);
  });

  it("Tradovate AccountNotActive pauses with its own reason", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateAccountNotActiveError(4242),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([[4242, "tradovate_account_not_active"]]);
  });

  it("Tradovate AccountNotActive with a null accountId falls back to the caller's account", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateAccountNotActiveError(null),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([[FALLBACK_ACCOUNT, "tradovate_account_not_active"]]);
  });

  it("an order rejection carrying failureReason AccountNotActive pauses like the typed error", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateOrderRejectionError("/order/placeOSO", 4242, "AccountNotActive", null),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([[4242, "tradovate_account_not_active"]]);
  });

  it("Tradovate captcha lockout pauses the account", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateCaptchaLockoutError("/auth/accesstokenrequest", 4242),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([[4242, "tradovate_captcha_lockout"]]);
  });

  it("Tradovate 401 pauses the account — it carries no accountId, so the fallback is used", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateUnauthorizedError("/order/placeOSO"),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([[FALLBACK_ACCOUNT, "tradovate_unauthorized"]]);
  });
});

describe("maybeOrphanFromBrokerError — kinds that must NOT pause", () => {
  it("an order rejection for any other failureReason does not pause — a risk limit is not a dead account", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateOrderRejectionError("/order/placeOSO", 4242, "RiskExceeded", "over limit"),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([]);
  });

  it("a circuit-open error does not pause — it is transient and the next tick retries", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateCircuitOpenError("/order/placeOSO", 4242, Date.now(), 60_000),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([]);
  });

  it("an auth-penalty error does not pause — rate_limited is not account-fatal", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new TradovateAuthPenaltyError(30),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([]);
  });

  it("Topstep's 401 does not pause — its auth failure is engine-scoped, and stopping AND pausing would be both", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new UnauthorizedError("/api/Order/place"),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([]);
  });

  it("an error no plugin owns does not pause, however auth-shaped its message", () => {
    priv(makeEngine()).maybeOrphanFromBrokerError(
      new Error("unauthorized: token may be expired"),
      FALLBACK_ACCOUNT,
    );
    expect(orphanCalls()).toEqual([]);
  });
});

// ── isEngineFatalAuthError ────────────────────────────────────────────────────

describe("isEngineFatalAuthError", () => {
  it("is true for Topstep's 401 — that credential is the session the engine runs on", () => {
    expect(priv(makeEngine()).isEngineFatalAuthError(new UnauthorizedError("/api/Order/place")))
      .toBe(true);
  });

  it("is false for Tradovate's 401 — account-scoped, so it orphan-pauses instead", () => {
    expect(priv(makeEngine()).isEngineFatalAuthError(new TradovateUnauthorizedError("/order/placeOSO")))
      .toBe(false);
  });

  it("is false for Topstep's AccountNotFound — same broker, but not an auth kind", () => {
    expect(priv(makeEngine()).isEngineFatalAuthError(new AccountNotFoundError(4242)))
      .toBe(false);
  });

  it("is false for an unowned error, even though both plugins' classifyError defaults to auth", () => {
    // This is the whole reason `ownsError` exists: classifyError is total,
    // so asking Topstep about a stray Error returns "auth" and would stop
    // the engine on any unrecognised throw out of the tick loop.
    expect(priv(makeEngine()).isEngineFatalAuthError(new Error("something else went wrong")))
      .toBe(false);
  });
});

// ── rejectionProvesTerminal ───────────────────────────────────────────────────

/**
 * The A46 seam's third link. Its two halves are pinned elsewhere —
 * `tradovate-plugin.test.ts` asserts the plugin delegates to the shipped
 * predicate, `engine-watchdog.test.ts` drives the predicate through the dep —
 * but the expression that joins them carries the fail-safe default and was
 * exercised by nothing, so `?? false` could become `?? true` with the suite
 * fully green. That mutation stamps `terminal_at` on every unattributed throw
 * and downgrades the armed-reverse `error` to a `warn`, which is A46 back
 * through the seam built to stop it.
 */
describe("rejectionProvesTerminal — the watchdog dep the engine wires", () => {
  const ask = (err: unknown) => priv(makeEngine()).nakedWatchdog.deps.rejectionProvesTerminal(err);

  it("answers true only through the owning plugin's shipped predicate", () => {
    expect(ask(new TradovateOrderRejectionError("/order/cancelOrder", 4242, "OrderNotFound", null)))
      .toBe(true);
  });

  it("stays loud for an unattributed transport 404 — A46", () => {
    // The message the client assembles around a non-2xx, verbatim: a bad base
    // URL or a revoked route reads as `Not Found` and owns no plugin.
    expect(ask(new Error("Tradovate API error 404 on /order/cancelOrder: Not Found")))
      .toBe(false);
  });

  it("stays loud for a broker that declares nothing — Topstep owns this one and has no member", () => {
    expect(ask(new AccountNotFoundError(4242))).toBe(false);
  });

  it("stays loud for a non-Error throw", () => {
    expect(ask(null)).toBe(false);
  });
});

// ── The log seam never throws into its caller ────────────────────────────────
//
// `log`/`logEvent` are called from `.catch` arms and void-dispatched promises,
// where a throw is a second unhandled rejection and terminates Node. `emit`
// stores the record before the handler runs, so the handler is the one
// surface that can throw (bugs.md, "deps.log and deps.logEvent are unguarded").

type LogSeam = {
  log(deploymentId: string, severity: "warn" | "error", category: "system", message: string): void;
  logEvent(event: string, deploymentId: string, message: string): void;
};

describe("the log seam — a throwing handler", () => {
  beforeEach(() => resetLogBursts());

  it("does not throw out of logEvent or log, and is said once on the console", () => {
    const engine = makeEngine();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn(() => {
      throw new Error("ring is full");
    });
    engine.setLogHandler(handler);
    const seam = engine as unknown as LogSeam;

    expect(() => seam.logEvent("tick_failed", "__engine__", "first")).not.toThrow();
    expect(() => seam.log("__engine__", "warn", "system", "second")).not.toThrow();

    // The handler was reached both times; only the report is once.
    expect(handler).toHaveBeenCalledTimes(2);
    const reports = consoleError.mock.calls.filter((c) => String(c[0]).includes("log handler threw"));
    expect(reports).toHaveLength(1);
    consoleError.mockRestore();
  });

  it("reports again for a handler installed after the broken one", () => {
    const engine = makeEngine();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const seam = engine as unknown as LogSeam;
    // Distinct messages: the pipe folds a repeat inside its burst window.
    for (const n of [1, 2]) {
      engine.setLogHandler(() => {
        throw new Error("broken");
      });
      seam.log("__engine__", "warn", "system", `line ${n}`);
    }
    const reports = consoleError.mock.calls.filter((c) => String(c[0]).includes("log handler threw"));
    expect(reports).toHaveLength(2);
    consoleError.mockRestore();
  });
});

describe("maybeOrphanFromBrokerError — the void-dispatched pause", () => {
  beforeEach(() => resetLogBursts());

  it("catches a failed pause and says so at error, rather than leaving an unhandled rejection", async () => {
    const engine = makeEngine();
    const lines: Array<{ level: string; message: string }> = [];
    engine.setLogHandler((entry) => lines.push({ level: entry.level, message: entry.message }));
    vi.mocked(markOrphanedByAccount).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    priv(engine).maybeOrphanFromBrokerError(new AccountNotFoundError(4242), FALLBACK_ACCOUNT);
    await vi.waitFor(() => expect(lines.some((l) => l.message.includes("database is locked"))).toBe(true));

    const line = lines.find((l) => l.message.includes("database is locked"));
    expect(line?.level).toBe("error");
    expect(line?.message).toContain("Could not pause the deployments");
  });

  it("survives a failed pause whose own report reaches a throwing handler", async () => {
    // The two halves together: before the guard, this `.catch` arm's log call
    // was itself the second unhandled rejection.
    const engine = makeEngine();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    engine.setLogHandler(() => {
      throw new Error("ring is full");
    });
    vi.mocked(markOrphanedByAccount).mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    priv(engine).maybeOrphanFromBrokerError(new AccountNotFoundError(4242), FALLBACK_ACCOUNT);
    await vi.waitFor(() =>
      expect(consoleError.mock.calls.some((c) => String(c[0]).includes("log handler threw"))).toBe(true),
    );
    consoleError.mockRestore();
  });
});
