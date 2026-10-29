// @vitest-environment jsdom
/**
 * Which trades count toward the board's Session P&L.
 *
 * The board and the drill-in disagreed on staging: a leg read `R: $0.00`
 * while `/deployments/[id]` showed a closed loss for that same leg. A closed
 * row whose exit came from Layer 3 of the exit cascade carries a real
 * `pnlDollars` and a **null** `exitFilledAt`, and the session predicate
 * dropped it; the drill-in's server `SUM` has no such clause.
 *
 * **The fixtures use SQLite's timestamp shape, and that is load-bearing.**
 * `exitDetectedAt` arrives from `datetime('now')` as `YYYY-MM-DD HH:MM:SS`
 * with no zone marker, while `sessionStart` is ISO-8601. A first attempt at
 * this fix compared them as raw strings and seeded ISO into the fixture — six
 * green tests over a comparison that silently dropped every row sharing the
 * session's UTC date. A fixture that invents its own format for a column the
 * production code always writes is testing a database that does not exist.
 *
 * `getAccountRealizedSinceGross` is the same window in SQL; its tests are
 * in `db/trades.test.ts`. **These two must agree** — the SQL one decides
 * whether the engine may take another entry.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { refreshAllTrades } from "@/lib/hooks/use-trades";
import type { Position } from "@/lib/brokers/types";
import {
  buildSelectors,
  isInScope,
  parseTradeTimestamp,
  SESSION_ANCHOR_RECHECK_MS,
  useCmeSessionStart,
} from "./use-live-pnl";

vi.mock("@/lib/hooks/use-trades", () => ({ refreshAllTrades: vi.fn(), useTrades: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { StrategyTrade } from "@/lib/db/trade-types";

/** 18:00 ET on the Globex open, EDT. Shares a UTC *date* with any close
 *  between 18:00 and 20:00 ET — the window a raw string compare drops. */
const SESSION_START = "2025-06-01T22:00:00.000Z";

function trade(overrides: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    status: "closed",
    exitFilledAt: "2025-06-02T14:30:00.000Z",
    exitDetectedAt: "2025-06-02 14:30:00",
    updatedAt: "2025-06-02 14:30:00",
    pnlDollars: -124,
    ...overrides,
  } as unknown as StrategyTrade;
}

describe("parseTradeTimestamp — two shapes reach this column", () => {
  it("reads a bare SQLite timestamp as UTC, not local", () => {
    // `Date.parse("2025-06-02 14:30:00")` is local time, which is wrong by the
    // host's offset — silently correct on a UTC box and hours off elsewhere.
    expect(parseTradeTimestamp("2025-06-02 14:30:00")).toBe(
      Date.parse("2025-06-02T14:30:00.000Z"),
    );
  });

  it("reads an ISO broker timestamp unchanged", () => {
    expect(parseTradeTimestamp("2025-06-02T14:30:00.000Z")).toBe(
      Date.parse("2025-06-02T14:30:00.000Z"),
    );
  });

  it("answers NaN for something unparseable rather than 0", () => {
    // 0 is a real instant — 1970 — and would place the row before every
    // session start. NaN is what lets the caller refuse to guess.
    expect(Number.isNaN(parseTradeTimestamp("not a date"))).toBe(true);
  });
});

describe("isInScope — a closed trade with no fill timestamp is still a closed trade", () => {
  it("counts an approximated close in the first hours of the session", () => {
    // The staging case, and the one a raw `>=` dropped for the whole session.
    const t = trade({ exitFilledAt: null, exitDetectedAt: "2025-06-01 23:15:00" });

    expect(isInScope(t, "session", SESSION_START)).toBe(true);
  });

  it("counts an approximated close later in the same session", () => {
    const t = trade({ exitFilledAt: null, exitDetectedAt: "2025-06-02 14:30:00" });

    expect(isInScope(t, "session", SESSION_START)).toBe(true);
  });

  it("still counts an ordinary close through its ISO fill timestamp", () => {
    expect(isInScope(trade(), "session", SESSION_START)).toBe(true);
  });

  it("does not pull a previous session's approximated close into this one", () => {
    const t = trade({ exitFilledAt: null, exitDetectedAt: "2025-06-01 18:00:00" });

    expect(isInScope(t, "session", SESSION_START)).toBe(false);
  });

  it("is not dragged into this session by a healer touching updatedAt", () => {
    // Three healers bump `updatedAt` on a closed, unhealed row over a 7-day
    // window. Reading it here would put a week-old loss in today's session.
    const t = trade({
      exitFilledAt: null,
      exitDetectedAt: "2025-05-28 14:00:00",
      updatedAt: "2025-06-02 09:00:00",
    });

    expect(isInScope(t, "session", SESSION_START)).toBe(false);
  });

  it("prefers the fill timestamp once the heal pass lands", () => {
    const t = trade({
      exitFilledAt: "2025-06-01T18:00:00.000Z",
      exitDetectedAt: "2025-06-02 12:00:00",
    });

    expect(isInScope(t, "session", SESSION_START)).toBe(false);
  });

  it("includes a close exactly on the session boundary", () => {
    const t = trade({ exitFilledAt: null, exitDetectedAt: "2025-06-01 22:00:00" });

    expect(isInScope(t, "session", SESSION_START)).toBe(true);
  });

  it("excludes a row with neither timestamp rather than guessing", () => {
    const t = trade({ exitFilledAt: null, exitDetectedAt: null });

    expect(isInScope(t, "session", SESSION_START)).toBe(false);
  });

  it("excludes a row that is not closed, whatever its timestamps say", () => {
    for (const status of ["open", "pending_entry", "pending_exit", "entry_failed"] as const) {
      expect(isInScope(trade({ status }), "session", SESSION_START)).toBe(false);
    }
  });

  it("takes every closed trade in allTime scope without consulting a timestamp", () => {
    const ancient = trade({ exitFilledAt: null, exitDetectedAt: null });

    expect(isInScope(ancient, "allTime", SESSION_START)).toBe(true);
  });
});

// A68: `hasOpenPosition` was whether the broker read matched the trade row on
// `(accountId, contractId)`, so a key mismatch read as a positive claim of flat
// — the account chip said FLAT and the dashboard said OPEN 1 while the trade
// row, the ownership source of truth, held a position on each of two legs.
describe("A68 — an open trade row reads as in a position when no live position matched", () => {
  const SESSION = "2026-10-22T22:00:00.000Z";
  const deployments = [
    { id: "leg-a", accountId: 7001, ticker: "/MNQ", strategyKey: "orb" },
    { id: "leg-b", accountId: 7001, ticker: "/MES", strategyKey: "orb" },
  ];
  const openRow = (deploymentId: string, contractId: string, status = "open") =>
    trade({ deploymentId, accountId: 7001, contractId, status, exitFilledAt: null } as Partial<StrategyTrade>);
  const select = (trades: StrategyTrade[], positions: Position[] = []) =>
    buildSelectors({
      trades,
      positions,
      unrealizedForPosition: () => 42,
      deployments,
      sessionStart: SESSION,
      scope: "session",
    });

  it("answers in-position for the leg, the account and the page count with no broker match", () => {
    const s = select([openRow("leg-a", "MNQZ6"), openRow("leg-b", "MESZ6")]);

    expect(s.deployment("leg-a").hasOpenPosition).toBe(true);
    expect(s.account(7001).hasOpenPosition).toBe(true);
    expect(s.allAccounts().hasOpenPosition).toBe(true);
    expect(s.strategy("orb", 7001).hasOpenPosition).toBe(true);
    expect(s.openPositionCount()).toBe(2);
  });

  const matched: Position = {
    id: 1, accountId: 7001, contractId: "MNQZ6", creationTimestamp: SESSION, type: 1, size: 1, averagePrice: 24680,
  };

  it("counts a matched and an unmatched leg once each, and gives the account no unrealized reading", () => {
    // A68's board half: the unmatched leg has no mark, so the account's sum is
    // missing part of its money — `null`, never the matched leg's 42 alone.
    const s = select([openRow("leg-a", "MNQZ6"), openRow("leg-b", "MESZ6")], [matched]);

    expect(s.openPositionCount()).toBe(2);
    expect(s.deployment("leg-a").unrealized).toBe(42);
    expect(s.account(7001).unrealized).toBeNull();
    expect(s.account(7001).total).toBeNull();
    expect(s.allAccounts().total).toBeNull();
    expect(s.strategy("orb", 7001).unrealized).toBeNull();
  });

  it("A68 — an open row with no broker match has no unrealized reading, not $0.00", () => {
    const s = select([openRow("leg-a", "MNQZ6")]);

    expect(s.deployment("leg-a").unrealized).toBeNull();
    expect(s.deployment("leg-a").total).toBeNull();
    expect(s.deployment("leg-a").realized).toBe(0);
  });

  it("A68 — a matched position with no mark has no unrealized reading either", () => {
    const s = buildSelectors({
      trades: [openRow("leg-a", "MNQZ6")],
      positions: [matched],
      unrealizedForPosition: () => null,
      deployments,
      sessionStart: SESSION,
      scope: "session",
    });

    expect(s.deployment("leg-a").unrealized).toBeNull();
    expect(s.account(7001).unrealized).toBeNull();
  });

  it("gives a matched, priced position its number, and a flat leg a real zero", () => {
    const s = select([openRow("leg-a", "MNQZ6")], [matched]);

    expect(s.deployment("leg-a").unrealized).toBe(42);
    expect(s.deployment("leg-a").total).toBe(42);
    expect(s.account(7001).unrealized).toBe(42);
    expect(s.deployment("leg-b").unrealized).toBe(0);
    expect(s.deployment("leg-b").total).toBe(0);
  });

  it("still reads flat for a pending entry nothing has filled", () => {
    const s = select([openRow("leg-a", "MNQZ6", "pending_entry")]);

    expect(s.deployment("leg-a").hasOpenPosition).toBe(false);
    expect(s.openPositionCount()).toBe(0);
  });

  it("counts only the current account's closes in R: after a move (trade history persists across account reassignment)", () => {
    // leg-a trades on 7001 now; a close it made on 6999 before the move is
    // the old account's money, not this row's.
    const closedOn = (accountId: number, pnlDollars: number) =>
      trade({ deploymentId: "leg-a", accountId, status: "closed", pnlDollars, exitFilledAt: "2026-10-23T14:00:00.000Z" } as Partial<StrategyTrade>);
    const s = select([closedOn(6999, -250.96), closedOn(7001, -134.22)]);

    expect(s.deployment("leg-a").realized).toBe(-134.22);
    expect(s.deployment("leg-a").closedCount).toBe(1);
  });
});

// A17: at the 17:00 ET anchor flip the scope moved but the trade list did not,
// so the session figure was computed over rows read under the old anchor until
// the next poll happened to land.
describe("A17 — useCmeSessionStart refetches trades when the session anchor flips", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    vi.mocked(refreshAllTrades).mockClear();
  });

  function mount(accountId: number | null): { anchor: () => string } {
    let anchor = "";
    function Harness() {
      anchor = useCmeSessionStart(accountId);
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Harness)));
    return { anchor: () => anchor };
  }

  it("refreshes the account's trades once, at the flip, and not on mount", () => {
    vi.useFakeTimers();
    // Monday 16:59:45 EDT: inside the session that opened Sunday 18:00 ET.
    vi.setSystemTime(new Date("2026-10-19T20:59:45.000Z"));
    const h = mount(5001);
    const before = h.anchor();
    expect(refreshAllTrades).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(SESSION_ANCHOR_RECHECK_MS));

    expect(h.anchor()).not.toBe(before);
    expect(refreshAllTrades).toHaveBeenCalledTimes(1);
    expect(refreshAllTrades).toHaveBeenCalledWith(5001);
  });

  it("does not refresh on a recheck that finds the same anchor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T14:00:00.000Z"));
    mount(null);

    act(() => vi.advanceTimersByTime(SESSION_ANCHOR_RECHECK_MS * 3));

    expect(refreshAllTrades).not.toHaveBeenCalled();
  });
});
