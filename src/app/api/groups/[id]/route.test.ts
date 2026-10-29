/**
 * The group PATCH's engine hand-off.
 *
 * One property, and it is the whole file: a group update reaches the engine.
 * It did not. `sync()` was called only inside this route's two 0-leg
 * tombstone branches, so the normal path — pause and unpause — updated the
 * database, returned 200, and left the engine's `realtimeDeployments`
 * untouched.
 *
 * **Pause is why it survived.** The closing guard reads `listClosing()`
 * straight from the DB on its own interval and never consults
 * `realtimeDeployments`, so pausing a group flattened and settled correctly
 * and read as proof the route was sound. Unpause has no DB-driven path: a leg
 * trades only once `sync()` puts it back in the engine's set, and nothing
 * re-reads that on a timer. An unpaused group therefore rendered `Active` and
 * never took another entry — observed on staging 2026-08-25 across several
 * 1-minute bars.
 *
 * The assertion is deliberately "was the engine told", not "what was it told":
 * this route's job at that seam is the hand-off, and pinning the payload would
 * couple the test to `listManagedDeployments`' filtering rather than to the
 * behaviour that broke.
 *
 * **The inputs matter as much as the assertion, and the first version got them
 * wrong.** `{ name: "renamed" }` never satisfies `isEnableTransition`, so the
 * only case here exercised the plain-update path and the enable/disable
 * cascade — the thing that actually mutates every leg — was never entered.
 * Three of the cases below are toggles for that reason, and three of those
 * assert the hand-off still happens on a **non-200** exit: the cascade commits
 * ~150 lines before the first `sync()` and every gate between them returns
 * early.
 *
 * `@/lib/db/account-brokers` and `@/lib/db/trades` are mocked because leaving
 * them real put the enable half out of reach entirely —
 * `screenAccountsForAutoTrade` fell through to the throwing `getDb()` stub, so
 * the half that broke on staging was the half no fixture could reach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
  registerPreCloseHook: vi.fn(),
}));

// Session gate: stub the store seam, keep the gate itself real.
vi.mock("@/lib/db/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/auth")>()),
  validateSession: vi.fn(() => true),
}));

const MAIN_SESSION = { start: "09:30", end: "16:00", timezone: "America/New_York" };

const GROUP = {
  id: "grp-1",
  name: "Demo Fixture (TEST)",
  strategyKey: "demo-fixture.test",
  ticker: "/MNQ",
  enabled: true,
  deletedAt: null,
  paramValues: { mainSession: MAIN_SESSION } as Record<string, unknown>,
};

const LEG = {
  id: "leg-1",
  groupId: "grp-1",
  accountId: 90055646,
  ticker: "/MNQ",
  status: "Active",
  deletedAt: null,
};

vi.mock("@/lib/db/deployment-groups", () => ({
  getGroup: vi.fn(() => GROUP),
  updateGroup: vi.fn(() => GROUP),
  softDeleteGroup: vi.fn(() => GROUP),
  beginGroupDestroy: vi.fn(() => GROUP),
  syncLegsFromGroup: vi.fn(),
  disableGroupWithSnapshot: vi.fn(() => GROUP),
  enableGroupAndRestore: vi.fn(() => GROUP),
}));

vi.mock("@/lib/db/deployments", () => ({
  listGroupLegs: vi.fn(() => [LEG]),
  listManagedDeployments: vi.fn(() => [LEG]),
  getDeployment: vi.fn(() => LEG),
  updateDeployment: vi.fn(() => LEG),
  setDeploymentStatus: vi.fn(() => LEG),
  // The window is the playbook's, so the route resolves it from the
  // `strategyKey` rather than out of the patch body.
  sessionForStrategyKey: vi.fn(() => MAIN_SESSION),
  readPauseWindows: vi.fn((params: Record<string, unknown> | undefined) => {
    const pw = params?.pauseWindows;
    return Array.isArray(pw) ? pw : [];
  }),
  findConflictingDeployments: vi.fn(() => []),
  filterMainSessionOverlaps: vi.fn(() => []),
}));

// The one pointer between a book and the row it materialised. `DELETE` is the
// only reader here: a derived row is the book grid's to stand down.
vi.mock("@/lib/db/books", () => ({
  listDerivedRows: vi.fn(() => []),
}));

vi.mock("@/lib/db/account-brokers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/account-brokers")>()),
  screenAccountsForAutoTrade: vi.fn(() => null),
}));

vi.mock("@/lib/db/trades", () => ({
  getOpenTradeForDeployment: vi.fn(() => null),
}));

// The gate's third arm. Enumerated rather than spread: the real module reaches
// both broker clients. Stubbed so the broker answer — including "no answer at
// all" — is a fixture rather than a side effect of whichever mock happens to
// throw first; the fail-closed catch under test lives in
// `legHasOpenPositionWithFallback`, which stays real.
vi.mock("@/lib/trading/broker-access/open-position-lookup", () => ({
  createOpenPositionLookup: vi.fn(() => vi.fn(async () => [])),
  createBootOpenPositionLookup: vi.fn(() => vi.fn(async () => [])),
  hasOpenPositionOnBroker: vi.fn(async () => false),
}));

// Stubbed so a refused enable can be shown to announce nothing.
vi.mock("@/lib/realtime/broadcaster-singleton", () => ({
  peekBroadcaster: vi.fn(() => null),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getEngineIfReady: vi.fn(),
  getTradovateClientIfConfigured: vi.fn(async () => null),
}));

// Enumerated, not spread: the real module is the `require.context` strategy
// loader, which has no vitest equivalent and fails the whole file at import.
// The param refusal it answers is exercised by flipping this return value; the
// sentence itself is `filters/index.test.ts`'s.
vi.mock("@/lib/trading/strategies", () => ({
  crossTimeframeExitRefusalForStrategyKey: vi.fn(() => null),
  getStrategy: vi.fn(() => undefined),
}));

import { DELETE, PATCH } from "./route";
import { listDerivedRows } from "@/lib/db/books";
import { BOOK_DERIVED_ROW_REFUSAL, RESUME_WOULD_RETRACT_A_CLOSE } from "@/lib/trading/domain";
import { LIVE_ACCOUNT_REFUSAL } from "@/lib/trading/broker-access/account-trading-policy";
import { getEngineIfReady } from "@/lib/trading/engine/engine-singleton";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { getOpenTradeForDeployment } from "@/lib/db/trades";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { hasOpenPositionOnBroker } from "@/lib/trading/broker-access/open-position-lookup";
import {
  beginGroupDestroy,
  disableGroupWithSnapshot,
  enableGroupAndRestore,
  softDeleteGroup,
  syncLegsFromGroup,
  updateGroup,
} from "@/lib/db/deployment-groups";
import { listGroupLegs, filterMainSessionOverlaps, sessionForStrategyKey } from "@/lib/db/deployments";
import { crossTimeframeExitRefusalForStrategyKey, getStrategy } from "@/lib/trading/strategies";
import {
  PLAYBOOK_MAX_CONTRACTS_REFUSAL,
  PLAYBOOK_RISK_PERCENT_REFUSAL,
} from "@/lib/trading/orders/risk-sizer";
import { withCommonParams, type CommonParams, type StrategyModule } from "@/lib/trading/strategy-types";

const EMA_TOO_LONG = "Hourly EMA length above 50 takes no entry: set 50 or less.";

const PLAYBOOK = {
  params: withCommonParams({
    emaLength: { type: "integer", label: "Hourly EMA length", default: 21 },
    entryMode: {
      type: "select",
      label: "Entry",
      default: "close",
      options: [
        { value: "close", label: "On the close" },
        { value: "retest", label: "On a retest" },
      ],
    },
  }),
  settingsRefusal: (params: CommonParams) => ((params.emaLength as number) > 50 ? EMA_TOO_LONG : null),
} as Pick<StrategyModule, "params" | "settingsRefusal"> as StrategyModule;

function patchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/groups/grp-1", {
    method: "PATCH",
    // `requireSession` reads the `x-session-token` header, not a cookie.
    headers: { "content-type": "application/json", "x-session-token": "test" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/groups/[id] — the engine hand-off", () => {
  let sync: ReturnType<typeof vi.fn>;
  let nudgeClosingGuard: ReturnType<typeof vi.fn>;
  let peekState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    GROUP.enabled = true;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    sync = vi.fn();
    nudgeClosingGuard = vi.fn();
    peekState = vi.fn(() => ({ position: null }));
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard,
      peekState,
    } as never);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  });

  it("syncs the engine on the normal path — a plain group edit", async () => {
    // Fails before the fix: `sync` was reachable only from the two tombstone
    // branches, so a plain group update returned 200 having told the engine
    // nothing.
    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("syncs on unpause — the half nothing DB-driven covers", async () => {
    // The staging failure itself. A leg re-enters the engine's set only when
    // `sync()` puts it there; a disable is rescued by the closing guard's own
    // DB read, an enable by nothing at all.
    GROUP.enabled = false;

    const res = await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    expect(enableGroupAndRestore).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("syncs after the disable cascade when every leg was flat", async () => {
    const res = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    expect(disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
    expect(nudgeClosingGuard).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("nudges the closing guard and syncs when the cascade put a leg in `Pausing`", async () => {
    // The cascade writes `Pausing` for exactly the legs this gate reports in
    // position, and that work then waited for the guard's 15s interval.
    peekState.mockReturnValue({ position: { side: "long", size: 1 } });

    const res = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    expect(nudgeClosingGuard).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("refuses bad settings before the enable, so a 400 never leaves the group enabled", async () => {
    // Until 2026-10-22 the settings were checked after `enableGroupAndRestore`
    // had written `Active`, so this body enabled the group and then answered
    // 400. The settings check now runs before any write.
    GROUP.enabled = false;

    const res = await PATCH(
      patchRequest({
        enabled: true,
        paramValues: { mainSession: MAIN_SESSION, pauseWindows: "nope" },
      }),
      { params: Promise.resolve({ id: "grp-1" }) } as never,
    );

    expect(res.status).toBe(400);
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
  });

  it("refuses settings that are not an object", async () => {
    const res = await PATCH(patchRequest({ paramValues: [1] }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);
    expect(res.status).toBe(400);
  });

  it("syncs when the session-window gate 409s after the disable cascade", async () => {
    // `{enabled: false, paramValues: {}}` on a group carrying a pause window:
    // `afterPauses` is empty, so the active interval reads as changed and the
    // in-position leg 409s — after the cascade has already committed it to
    // `Pausing`. (The window itself is the playbook's and cannot be patched;
    // the pause list is the half a save can still move.)
    GROUP.paramValues = { pauseWindows: [{ start: "12:00", end: "13:00" }] };
    peekState.mockReturnValue({ position: { side: "long", size: 1 } });

    const res = await PATCH(patchRequest({ enabled: false, paramValues: {} }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(409);
    expect(disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  // The only surface that can turn an exit filter onto a non-strategy
  // timeframe after creation — the leg PATCH refuses `paramValues` outright —
  // so without this gate the create routes' refusal is bypassed by creating on
  // "Same as strategy" and editing afterwards.
  it("refuses a params edit that puts an exit filter on a timeframe no backtest can serve", async () => {
    // `Once`, not `mockReturnValue`: `clearAllMocks` clears calls and not
    // implementations, so a sticky sentence would 400 every later case.
    vi.mocked(crossTimeframeExitRefusalForStrategyKey).mockReturnValueOnce(
      "EMA Close-Through is set to read 15m bars, and only the live engine fetches those.",
    );

    const res = await PATCH(
      patchRequest({ paramValues: { mainSession: MAIN_SESSION, emaExitTimeframe: "15m" } }),
      { params: Promise.resolve({ id: "grp-1" }) } as never,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "EMA Close-Through is set to read 15m bars, and only the live engine fetches those.",
    });
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it("stores the playbook's cap and share sent as text as the numbers they spell", async () => {
    const res = await PATCH(
      patchRequest({ paramValues: { mainSession: MAIN_SESSION, playbookMaxContracts: "1", playbookRiskPercent: "50" } }),
      { params: Promise.resolve({ id: "grp-1" }) } as never,
    );

    expect(res.status).toBe(200);
    expect(vi.mocked(updateGroup).mock.calls[0][1].paramValues).toEqual({
      mainSession: MAIN_SESSION,
      playbookMaxContracts: 1,
      playbookRiskPercent: 50,
    });
  });

  for (const [label, paramValues, error] of [
    ["a cap above the reviewed ceiling", { playbookMaxContracts: 4 }, PLAYBOOK_MAX_CONTRACTS_REFUSAL],
    ["a fractional cap", { playbookMaxContracts: 1.5 }, PLAYBOOK_MAX_CONTRACTS_REFUSAL],
    ["a share of 0%", { playbookRiskPercent: 0 }, PLAYBOOK_RISK_PERCENT_REFUSAL],
    ["a share that is not a number", { playbookRiskPercent: "half" }, PLAYBOOK_RISK_PERCENT_REFUSAL],
  ] as const) {
    it(`refuses ${label} and writes nothing`, async () => {
      const res = await PATCH(patchRequest({ paramValues: { mainSession: MAIN_SESSION, ...paramValues } }), {
        params: Promise.resolve({ id: "grp-1" }),
      } as never);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
      expect(updateGroup).not.toHaveBeenCalled();
    });
  }

  // A113: every setting by its playbook's declared type, then the playbook's
  // own settings check. `Once`, for the reason the cross-timeframe case gives.
  it("stores a number sent as text as the number", async () => {
    vi.mocked(getStrategy).mockReturnValueOnce(PLAYBOOK);
    const res = await PATCH(patchRequest({ paramValues: { emaLength: "21", entryMode: "retest" } }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateGroup).mock.calls[0][1].paramValues).toEqual({ emaLength: 21, entryMode: "retest" });
  });

  it("refuses text that is no number with a 400 naming the setting, and writes nothing", async () => {
    vi.mocked(getStrategy).mockReturnValueOnce(PLAYBOOK);
    const res = await PATCH(patchRequest({ paramValues: { emaLength: "abc" } }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Hourly EMA length must be a whole number, and "abc" is not one.' });
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it("refuses an option that is not on the playbook's list", async () => {
    vi.mocked(getStrategy).mockReturnValueOnce(PLAYBOOK);
    const res = await PATCH(patchRequest({ paramValues: { entryMode: "open" } }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(400);
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it("refuses what the playbook's own settings check rejects, and writes nothing", async () => {
    vi.mocked(getStrategy).mockReturnValueOnce(PLAYBOOK);
    const res = await PATCH(patchRequest({ paramValues: { emaLength: 60 } }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: EMA_TOO_LONG });
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it("does not throw when the engine is not ready", async () => {
    // `getEngineIfReady` is null before boot and after either fatal-auth
    // stop(); the route must still complete the DB half.
    vi.mocked(getEngineIfReady).mockReturnValue(null as never);

    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
  });
});

/**
 * The reconciler is the only writer of a derived row's state — a direct
 * `enabled` toggle here would make this group its own slot holder, and the
 * book grid could never resume it. Checked ahead of the cascade, on the same
 * ordering the DELETE refusal uses.
 */
describe("PATCH /api/groups/[id] — a derived group's enabled switch is the reconciler's", () => {
  const ctx = { params: Promise.resolve({ id: "grp-1" }) } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    GROUP.enabled = true;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    vi.mocked(listGroupLegs).mockReturnValue([LEG] as never);
    vi.mocked(getEngineIfReady).mockReturnValue(null as never);
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  });

  it("409s a toggle on a row a book materialised, before the cascade runs", async () => {
    vi.mocked(listDerivedRows).mockReturnValue([
      { groupId: "grp-1", bookId: "book-1", ticker: "/MNQ", strategyKey: "demo-fixture.test", enabled: true },
    ]);

    const res = await PATCH(patchRequest({ enabled: false }), ctx);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BOOK_DERIVED_ROW_REFUSAL);
    expect(disableGroupWithSnapshot).not.toHaveBeenCalled();
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
  });

  it("toggles a hand-made row as before", async () => {
    vi.mocked(listDerivedRows).mockReturnValue([]);

    const res = await PATCH(patchRequest({ enabled: false }), ctx);

    expect(res.status).toBe(200);
    expect(disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
  });
});

/**
 * The cascade's own in-position gate.
 *
 * `legHasOpenPositionWithFallback` short-circuits on `if (state) return
 * state.position != null`, and every managed leg has a state entry while the
 * engine runs — so the broker arm never fires here and the mirror is the whole
 * answer. During the submission-to-fill window the mirror is null and the
 * trade row is `pending_exit`, which classifies the leg as flat and writes
 * `Paused` over a live broker position. `PATCH /api/deployments/[id]`'s
 * `holdsPosition` has opened with the trade-row read since P3 for exactly this
 * reason; the group cascade had no equivalent.
 */
describe("PATCH /api/groups/[id] — the disable cascade's in-position gate", () => {
  let sync: ReturnType<typeof vi.fn>;
  let nudgeClosingGuard: ReturnType<typeof vi.fn>;
  let peekState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    GROUP.enabled = true;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    sync = vi.fn();
    nudgeClosingGuard = vi.fn();
    // The mirror says flat — `placeExitOrder`'s callers null it at submission.
    peekState = vi.fn(() => ({ position: null }));
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard,
      peekState,
    } as never);
  });

  it("reports a leg with a `pending_exit` trade row as in position", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({
      id: 42,
      status: "pending_exit",
    } as never);

    const res = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    const inPosition = vi.mocked(disableGroupWithSnapshot).mock.calls[0]?.[1];
    expect(inPosition?.(LEG as never)).toBe(true);
    // `Pausing` was written, so the flatten must not wait a guard interval.
    expect(nudgeClosingGuard).toHaveBeenCalledTimes(1);
  });

  it("still reports flat when neither the trade row nor the mirror has anything", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);

    const res = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    const inPosition = vi.mocked(disableGroupWithSnapshot).mock.calls[0]?.[1];
    expect(inPosition?.(LEG as never)).toBe(false);
    expect(nudgeClosingGuard).not.toHaveBeenCalled();
  });
});

/** Re-arm every module mock this file drives from a test body. `clearAllMocks`
 *  clears calls but keeps implementations, so a `mockReturnValue` set in one
 *  test survives into the next one. */
function armDefaults() {
  vi.mocked(listGroupLegs).mockReturnValue([LEG] as never);
  vi.mocked(updateGroup).mockReturnValue(GROUP as never);
  vi.mocked(softDeleteGroup).mockReturnValue(GROUP as never);
  vi.mocked(filterMainSessionOverlaps).mockReturnValue([]);
  vi.mocked(screenAccountsForAutoTrade).mockReturnValue(null);
  vi.mocked(getOpenTradeForDeployment).mockReturnValue(null);
  vi.mocked(hasOpenPositionOnBroker).mockResolvedValue(false);
}

/**
 * The other half of the `respondSynced` rule.
 *
 * The three cases in the first describe cover the exits the fix's own tests
 * named. These are the ones it did not: a toggle that fails, the group-row
 * update that fails, the post-cascade conflict fan-out, and both 0-leg
 * tombstones. Each one commits something and then leaves through a different
 * `return`, and the failure they share is silent — the DB is right, the
 * response is right, and the engine is holding a deployment set that no longer
 * matches, indefinitely.
 */
describe("PATCH /api/groups/[id] — the exits the cascade fix did not name", () => {
  let sync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    armDefaults();
    GROUP.enabled = true;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    sync = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard: vi.fn(),
      peekState: vi.fn(() => ({ position: null })),
    } as never);
  });

  it("syncs when the toggle itself reports failure", async () => {
    // A cascade that returns null has still touched rows on the way to
    // failing; the engine's view is no more trustworthy than after one that
    // succeeded.
    GROUP.enabled = false;
    vi.mocked(enableGroupAndRestore).mockReturnValue(null as never);

    const res = await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(500);
    expect(enableGroupAndRestore).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("syncs when the post-cascade conflict fan-out 409s", async () => {
    // `{enabled:false}` skips the enable pre-check, so this reaches the second
    // conflict fan-out — the one downstream of a committed cascade.
    vi.mocked(filterMainSessionOverlaps).mockReturnValue([
      { id: "other-depl", name: "Other", strategyKey: "demo-fixture.test" },
    ] as never);

    const res = await PATCH(
      patchRequest({ enabled: false, paramValues: { mainSession: MAIN_SESSION } }),
      { params: Promise.resolve({ id: "grp-1" }) } as never,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ partialConflict: true });
    expect(disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("syncs when the group-row update fails after the cascade", async () => {
    vi.mocked(updateGroup).mockReturnValue(null as never);

    const res = await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(500);
    expect(disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("syncs when the 0-leg invariant tombstones the group on the way out", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([] as never);

    const res = await PATCH(patchRequest({ name: "renamed" }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(200);
    expect(softDeleteGroup).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("tombstones and syncs when an enable finds the group has no legs left", async () => {
    // The repair-then-refuse branch. Without the sync the operator is told the
    // shell was cleared while the engine still holds it.
    GROUP.enabled = false;
    vi.mocked(listGroupLegs).mockReturnValue([] as never);

    const res = await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(409);
    expect(softDeleteGroup).toHaveBeenCalledTimes(1);
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

/**
 * The live-account block, on the group-enable path.
 *
 * Enabling a group cascades `enabled = 1` onto every leg, so it is a
 * "start trading here" for each of their accounts — and auto-trading a funded
 * Topstep account is a terminated account, not a bug report. This screen is
 * the only thing standing in front of that on this route, and until
 * `@/lib/db/account-brokers` was mocked it could not be reached from any
 * fixture in this file: `screenAccountsForAutoTrade` fell through to the
 * throwing `getDb` stub.
 *
 * The complement matters as much: these gates sit *upstream* of the cascade
 * and have mutated nothing, so unlike every exit above they must not sync.
 * A rule that reads "always sync" and one that reads "sync iff something was
 * committed" are indistinguishable without both directions.
 */
describe("PATCH /api/groups/[id] — enabling is screened before anything is committed", () => {
  const LEG_TWO = { ...LEG, id: "leg-2", accountId: 51234567 };
  let sync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    armDefaults();
    GROUP.enabled = false;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    sync = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard: vi.fn(),
      peekState: vi.fn(() => ({ position: null })),
    } as never);
  });

  it("screens every leg's account, not just the first", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([LEG, LEG_TWO] as never);

    await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(screenAccountsForAutoTrade).toHaveBeenCalledWith([LEG.accountId, LEG_TWO.accountId]);
  });

  it("refuses the enable and commits nothing when an account cannot be auto-traded", async () => {
    vi.mocked(screenAccountsForAutoTrade).mockReturnValue({
      message: "Auto-trading is not permitted on funded accounts.",
      refused: [{ accountId: LEG.accountId, reason: "Auto-trading is not permitted on funded accounts." }],
    });

    const res = await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ refusedAccounts: [{ accountId: LEG.accountId }] });
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
    expect(updateGroup).not.toHaveBeenCalled();
    // Nothing was committed, so there is nothing for the engine to hear about.
    expect(sync).not.toHaveBeenCalled();
  });

  // Ordering, and it is the reason the screen sits where it does: a session
  // conflict is something the operator can rearrange their way out of, and a
  // live account is not. Reporting the conflict first sends them to fix the
  // wrong thing.
  it("refuses on the live account even when a session conflict would also refuse", async () => {
    vi.mocked(screenAccountsForAutoTrade).mockReturnValue({
      message: "Auto-trading is not permitted on funded accounts.",
      refused: [{ accountId: LEG.accountId, reason: "Auto-trading is not permitted on funded accounts." }],
    });
    vi.mocked(filterMainSessionOverlaps).mockReturnValue([
      { id: "other-depl", name: "Other", strategyKey: "demo-fixture.test" },
    ] as never);

    const res = await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(403);
  });

  it("refuses at the conflict gate without touching the legs or the engine", async () => {
    vi.mocked(filterMainSessionOverlaps).mockReturnValue([
      { id: "other-depl", name: "Other", strategyKey: "demo-fixture.test" },
    ] as never);

    const res = await PATCH(patchRequest({ enabled: true }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);

    expect(res.status).toBe(409);
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});

/**
 * Operator decision 2026-10-07: an enable over a close in flight is refused
 * on the server. `enableGroupAndRestore` rewrites a `Pausing` leg from its
 * snapshot and drops its close, so the enable 409s whole — no partial resume
 * of the settled legs — before any write. A `Destroying` leg it skips, so that
 * one refuses nothing. Disable is the wind-down and is never refused.
 */
describe("PATCH /api/groups/[id] — enabling over a leg still closing", () => {
  const LEG_TWO = { ...LEG, id: "leg-2", accountId: 51234567, status: "Paused" };
  const ctx = () => ({ params: Promise.resolve({ id: "grp-1" }) }) as never;
  let sync: ReturnType<typeof vi.fn>;
  let emitDeploymentsChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    armDefaults();
    vi.mocked(listDerivedRows).mockReturnValue([]);
    vi.mocked(enableGroupAndRestore).mockReturnValue(GROUP as never);
    vi.mocked(disableGroupWithSnapshot).mockReturnValue(GROUP as never);
    GROUP.enabled = false;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    sync = vi.fn();
    emitDeploymentsChanged = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      nudgeClosingGuard: vi.fn(),
      peekState: vi.fn(() => ({ position: null })),
    } as never);
    vi.mocked(peekBroadcaster).mockReturnValue({ emitDeploymentsChanged } as never);
  });

  it("409s an enable when one leg is Pausing, and writes nothing to the group or any leg", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }, LEG_TWO] as never);

    const res = await PATCH(patchRequest({ enabled: true, name: "renamed" }), ctx());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: RESUME_WOULD_RETRACT_A_CLOSE });
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
    expect(disableGroupWithSnapshot).not.toHaveBeenCalled();
    expect(updateGroup).not.toHaveBeenCalled();
    expect(syncLegsFromGroup).not.toHaveBeenCalled();
    expect(softDeleteGroup).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(emitDeploymentsChanged).not.toHaveBeenCalled();
  });

  // Operator choice 3A: `enableGroupAndRestore` skips a `Destroying` leg, so
  // the delete still lands and refusing would strand the settled siblings
  // behind a delete that may be stuck on an unreachable broker.
  it("enables over a leg being destroyed, which the enable leaves alone", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Destroying" }, LEG_TWO] as never);

    const res = await PATCH(patchRequest({ enabled: true }), ctx());

    expect(res.status).toBe(200);
    expect(enableGroupAndRestore).toHaveBeenCalledWith("grp-1");
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("enables as before when every leg has settled", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Paused" }, LEG_TWO] as never);

    const res = await PATCH(patchRequest({ enabled: true }), ctx());

    expect(res.status).toBe(200);
    expect(enableGroupAndRestore).toHaveBeenCalledWith("grp-1");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(emitDeploymentsChanged).toHaveBeenCalledTimes(1);
  });

  it("still disables a group whose leg is closing — the wind-down is never refused", async () => {
    GROUP.enabled = true;
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }, LEG_TWO] as never);

    const res = await PATCH(patchRequest({ enabled: false }), ctx());

    expect(res.status).toBe(200);
    expect(disableGroupWithSnapshot).toHaveBeenCalledTimes(1);
  });

  it("still saves a plain edit on a disabled group whose leg is closing", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }] as never);

    const res = await PATCH(patchRequest({ name: "renamed" }), ctx());

    expect(res.status).toBe(200);
    expect(updateGroup).toHaveBeenCalledTimes(1);
  });

  it("answers the live-account 403 ahead of the close, which clears by waiting", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }] as never);
    vi.mocked(screenAccountsForAutoTrade).mockReturnValue({
      message: LIVE_ACCOUNT_REFUSAL,
      refused: [{ accountId: LEG.accountId, reason: LIVE_ACCOUNT_REFUSAL }],
    });

    const res = await PATCH(patchRequest({ enabled: true }), ctx());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(LIVE_ACCOUNT_REFUSAL);
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
  });

  it("answers the session conflict ahead of the close, which clears by waiting", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }] as never);
    vi.mocked(filterMainSessionOverlaps).mockReturnValue([
      { id: "other-depl", name: "Other", strategyKey: "demo-fixture.test" },
    ] as never);

    const res = await PATCH(patchRequest({ enabled: true }), ctx());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ partialConflict: true });
  });

  it("answers the unregistered-session 400 ahead of the close, which clears by waiting", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }] as never);
    vi.mocked(sessionForStrategyKey).mockReturnValueOnce(null);

    const res = await PATCH(patchRequest({ enabled: true }), ctx());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("is not registered");
    expect(enableGroupAndRestore).not.toHaveBeenCalled();
  });

  it("answers BOOK_DERIVED_ROW_REFUSAL ahead of the close on a book's row", async () => {
    vi.mocked(listGroupLegs).mockReturnValue([{ ...LEG, status: "Pausing" }] as never);
    // Once: `armDefaults` does not re-arm this mock for the describes below.
    vi.mocked(listDerivedRows).mockReturnValueOnce([
      { groupId: "grp-1", bookId: "book-1", ticker: "/MNQ", strategyKey: "demo-fixture.test", enabled: false },
    ]);

    const res = await PATCH(patchRequest({ enabled: true }), ctx());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BOOK_DERIVED_ROW_REFUSAL);
  });
});

/**
 * The gate's remaining arms.
 *
 * `pending_exit` was the clause the fix added, and it is covered above. The
 * property is wider than that one status: **every answer that is not a
 * definite "flat" has to come back as "in position"**, because the caller
 * writes `Paused` on a "flat" answer and `Paused` is a claim the deployment
 * holds nothing — it drops out of `listManagedDeployments()`, so the same
 * request's `sync()` deletes the leg's mirror, and out of `isLegInExitLoop`
 * and the watchdog's candidate set, leaving a live broker position with no
 * engine actor at all. A wrong "flat" here is unrecoverable without a human.
 */
describe("PATCH /api/groups/[id] — the in-position gate fails closed on every unknown", () => {
  let peekState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    armDefaults();
    GROUP.enabled = true;
    GROUP.paramValues = { mainSession: MAIN_SESSION };
    peekState = vi.fn(() => ({ position: null }));
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync: vi.fn(),
      nudgeClosingGuard: vi.fn(),
      peekState,
    } as never);
  });

  /** Run the disable cascade and hand back the classification it produced for
   *  `LEG` — the predicate the cascade itself consults, not a copy of it. */
  async function classifyLeg(): Promise<boolean | undefined> {
    await PATCH(patchRequest({ enabled: false }), {
      params: Promise.resolve({ id: "grp-1" }),
    } as never);
    return vi.mocked(disableGroupWithSnapshot).mock.calls[0]?.[1]?.(LEG as never);
  }

  // The row is live from submission until `closeTrade`, and the route reads
  // "is there a live row", not "is it `open`". A `pending_entry` row whose
  // entry is still working is a position about to exist.
  it("reports a leg with a `pending_entry` trade row as in position", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 43, status: "pending_entry" } as never);

    expect(await classifyLeg()).toBe(true);
  });

  it("reports the leg as in position when the engine is down and the broker cannot be asked", async () => {
    vi.mocked(getEngineIfReady).mockReturnValue(null as never);
    vi.mocked(hasOpenPositionOnBroker).mockRejectedValue(new Error("no Topstep token"));

    expect(await classifyLeg()).toBe(true);
  });

  it("reports the leg as in position when the engine has no state for it and the broker cannot be asked", async () => {
    // `peekState` answers `undefined` for a leg the engine has not rehydrated
    // — a cold boot, or a leg added since the last sync.
    peekState.mockReturnValue(undefined);
    vi.mocked(hasOpenPositionOnBroker).mockRejectedValue(new Error("Tradovate client unavailable"));

    expect(await classifyLeg()).toBe(true);
  });

  it("reports the leg as in position when the broker says the account holds one", async () => {
    peekState.mockReturnValue(undefined);
    vi.mocked(hasOpenPositionOnBroker).mockResolvedValue(true);

    expect(await classifyLeg()).toBe(true);
  });

  it("reports flat when the engine has no state and the broker answers flat", async () => {
    peekState.mockReturnValue(undefined);
    vi.mocked(hasOpenPositionOnBroker).mockResolvedValue(false);

    expect(await classifyLeg()).toBe(false);
  });

  // Source priority, and its cost. The mirror is preferred when present, which
  // is what keeps a group PATCH from costing one broker round-trip per leg.
  // Asserting only the verdict would keep passing if that order were inverted.
  it("does not ask the broker at all when the engine has state for the leg", async () => {
    vi.mocked(hasOpenPositionOnBroker).mockResolvedValue(true);

    expect(await classifyLeg()).toBe(false);
    expect(hasOpenPositionOnBroker).not.toHaveBeenCalled();
  });
});

/**
 * `✕` on a derived row is refused, which is what the reconciler's
 * no-delete-arm rule needs to be true from this end: a tombstoned derived row
 * is not a slot the reconciler leaves alone, so a delete that went through
 * would be undone at the next boot — a control that looks like it worked and
 * did not.
 */
describe("DELETE /api/groups/[id] — a derived row is the book grid's to stand down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armDefaults();
    vi.mocked(listDerivedRows).mockReturnValue([]);
    vi.mocked(getEngineIfReady).mockReturnValue(null as never);
  });

  function deleteRequest(): NextRequest {
    return new NextRequest("http://localhost/api/groups/grp-1", {
      method: "DELETE",
      headers: { "x-session-token": "test" },
    });
  }

  const ctx = { params: Promise.resolve({ id: "grp-1" }) } as never;

  it("409s a row a book materialised, with the sentence naming the grid, before the broker is asked", async () => {
    vi.mocked(listDerivedRows).mockReturnValue([
      { groupId: "grp-1", bookId: "book-1", ticker: "/MNQ", strategyKey: "demo-fixture.test", enabled: true },
    ]);

    const res = await DELETE(deleteRequest(), ctx);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(BOOK_DERIVED_ROW_REFUSAL);
    expect(softDeleteGroup).not.toHaveBeenCalled();
    expect(hasOpenPositionOnBroker).not.toHaveBeenCalled();
  });

  it("deletes a hand-made row as before", async () => {
    const res = await DELETE(deleteRequest(), ctx);

    expect(res.status).toBe(200);
    expect(softDeleteGroup).toHaveBeenCalledWith("grp-1");
  });
});

// bugs/group-destroy-refuses-when-a-leg-holds-a-position-while-per.md
describe("DELETE /api/groups/[id] — a leg in position closes through Destroying instead of a 409", () => {
  const ctx = { params: Promise.resolve({ id: "grp-1" }) } as never;
  let nudgeClosingGuard: ReturnType<typeof vi.fn>;
  let sync: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    armDefaults();
    vi.mocked(listDerivedRows).mockReturnValue([]);
    nudgeClosingGuard = vi.fn();
    sync = vi.fn();
    vi.mocked(getEngineIfReady).mockReturnValue({
      sync,
      peekState: vi.fn(() => undefined),
      nudgeClosingGuard,
    } as never);
  });

  it("cascades Destroying onto the leg in position instead of a 409, and starts the close", async () => {
    vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 7, status: "open" } as never);

    const res = await DELETE(
      new NextRequest("http://localhost/api/groups/grp-1", {
        method: "DELETE",
        headers: { "x-session-token": "test" },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, destroying: true });
    expect(beginGroupDestroy).toHaveBeenCalledTimes(1);
    const [groupId, inPosition] = vi.mocked(beginGroupDestroy).mock.calls[0];
    expect(groupId).toBe("grp-1");
    expect(inPosition(LEG as never)).toBe(true);
    expect(softDeleteGroup).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(nudgeClosingGuard).toHaveBeenCalledTimes(1);
  });

  it("deletes at once and nudges nothing when every leg is flat", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/groups/grp-1", {
        method: "DELETE",
        headers: { "x-session-token": "test" },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(softDeleteGroup).toHaveBeenCalledWith("grp-1");
    expect(beginGroupDestroy).not.toHaveBeenCalled();
    expect(nudgeClosingGuard).not.toHaveBeenCalled();
  });

  it("closes a leg whose entry landed during the broker read, rather than deleting it Paused", async () => {
    // The broker arm awaits with the parent still enabled; the engine opens an
    // entry on the leg the read already called flat.
    vi.mocked(hasOpenPositionOnBroker).mockImplementation(async () => {
      vi.mocked(getOpenTradeForDeployment).mockReturnValue({ id: 8, status: "pending_entry" } as never);
      return false;
    });

    const res = await DELETE(
      new NextRequest("http://localhost/api/groups/grp-1", {
        method: "DELETE",
        headers: { "x-session-token": "test" },
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, destroying: true });
    expect(softDeleteGroup).not.toHaveBeenCalled();
    const [, inPosition] = vi.mocked(beginGroupDestroy).mock.calls[0];
    expect(inPosition(LEG as never)).toBe(true);
    expect(nudgeClosingGuard).toHaveBeenCalledTimes(1);
  });
});
