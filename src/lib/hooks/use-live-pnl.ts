"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { refreshAllTrades, useTrades } from "@/lib/hooks/use-trades";
import { useDeployments } from "@/lib/hooks/use-strategies";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import type { StrategyTrade, TradeBucket } from "@/lib/db/trade-types";

/**
 * Centralized live-PnL selector. Every UI surface that shows realized,
 * unrealized, or combined PnL should pull from here so the math + scoping
 * decisions live in one place.
 *
 * Two scoping modes:
 *   - "session": realized = closed-trade pnl_dollars where exit_filled_at
 *     >= currentCmeSessionStart(). Matches the hero's Session PnL window.
 *   - "allTime": realized = every closed trade's pnl_dollars.
 *
 * Realized pnl_dollars on rows written after the 2026-04-26 engine update
 * is net of fees. Older rows are gross — they age out of the session
 * window quickly so the Dashboard surfaces (session-scoped) are unaffected.
 *
 * Unrealized always comes from the same source as the hero (live SSE
 * quotes via useTrading), so the two halves of any pill are guaranteed
 * to use the same mark.
 */

export type PnLScope = "session" | "allTime";

export interface PnLBreakdown {
  realized: number;
  /** `null` is "no reading": a held position nothing can price — no broker
   *  match, or no quote or contract meta for it. Never a zero (A68). */
  unrealized: number | null;
  fees: number;
  /** `null` whenever `unrealized` is: a total missing part of its money is
   *  not a total. */
  total: number | null;
  /** Counts so the UI can decide between "—" and "$0.00" without
   * re-walking the trade list. */
  closedCount: number;
  hasOpenPosition: boolean;
}

/** Per-bucket realized split, used by the All-Time card subtitle. The
 *  client walks the in-memory trade list and accumulates each closed
 *  trade's pnlDollars into its bucket. Trades without a `bucket` field
 *  (legacy/non-API paths) fall through to active. */
export interface BucketBreakdown {
  active: number;
  retired: number;
  trashed: number;
  manual: number;
}

interface DeploymentLite {
  id: string;
  accountId: number;
  ticker: string;
  strategyKey: string;
}

/** Realized plus unrealized, or `null` when the unrealized half has no reading. */
function plus(realized: number, unrealized: number | null): number | null {
  return unrealized == null ? null : realized + unrealized;
}

function emptyBreakdown(): PnLBreakdown {
  return {
    realized: 0,
    unrealized: 0,
    fees: 0,
    total: 0,
    closedCount: 0,
    hasOpenPosition: false,
  };
}

/**
 * Milliseconds for a timestamp off `strategy_trades`, whichever of the two
 * shapes it is in.
 *
 * Broker timestamps (`exitFilledAt`) are ISO-8601. Ones SQLite wrote
 * (`exitDetectedAt`) are `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker,
 * which `Date.parse` reads as *local* time — so this cannot be one bare
 * `Date.parse` call either. Returns `NaN` for anything unparseable, which
 * every caller must treat as "no reading" rather than as zero.
 */
export function parseTradeTimestamp(value: string): number {
  if (value.includes("T")) return Date.parse(value);
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

/**
 * Whether a trade counts toward a scope's realized total.
 *
 * Exported for its own test rather than reached through the hook: it is the
 * one decision here that has been wrong in a way no rendering assertion would
 * catch, and it has a server-side twin in `getAccountRealizedSinceGross`
 * that must agree with it.
 */
export function isInScope(t: StrategyTrade, scope: PnLScope, sessionStart: string): boolean {
  if (t.status !== "closed") return false;
  if (scope === "allTime") return true;
  // session: include only trades that closed on or after the current CME
  // session start.
  //
  // **A closed row with no `exitFilledAt` is an ordinary state, not a
  // defensive edge.** Layer 3 of the exit cascade writes a real `pnlDollars`
  // with a null fill timestamp and lets the heal pass fill it in later, so
  // excluding those dropped every approximated close out of session realized
  // while the drill-in's uncapped server `SUM` still counted it — the board
  // read `R: $0.00` on a leg the drill-in showed a closed loss for.
  //
  // **The fallback is `exitDetectedAt`, not `updatedAt`.** `updatedAt` means
  // "any write", and three healers bump it on a closed, unhealed row over a
  // 7-day window — a week-old loss would land in today's session.
  //
  // **And it is parsed, not compared as text.** `exitDetectedAt` is SQLite's
  // `datetime('now')` (`YYYY-MM-DD HH:MM:SS`) while `sessionStart` is
  // ISO-8601; as raw strings `' '` sorts before `'T'`, so every row sharing
  // the session's UTC date silently dropped — which is every close in the
  // Globex open, for the whole session. `getAccountRealizedSinceGross` is
  // the same window in SQL and must agree; there the stakes are the
  // daily-loss gate rather than a label.
  const closedAt = t.exitFilledAt ?? t.exitDetectedAt;
  if (!closedAt) return false;
  const closedMs = parseTradeTimestamp(closedAt);
  const startMs = Date.parse(sessionStart);
  if (!Number.isFinite(closedMs) || !Number.isFinite(startMs)) return false;
  return closedMs >= startMs;
}

export const SESSION_ANCHOR_RECHECK_MS = 30_000;

/**
 * The current CME session's start, re-evaluated every
 * {@link SESSION_ANCHOR_RECHECK_MS} so Session PnL flips to $0 at 17:00 ET (and
 * again at 18:00 when the next session opens) without a refresh.
 *
 * A flip also refetches `accountId`'s trades. The scope moves the instant the
 * anchor does, but the list it filters is whatever the last 5s poll read, so
 * until the next poll lands the figure is computed over rows read under the
 * old anchor. Refetching from the interval callback, not an effect on the
 * returned value, keeps mount from costing a read.
 */
export function useCmeSessionStart(accountId: number | null | undefined): string {
  const [sessionStart, setSessionStart] = useState(() => currentCmeSessionStart());
  const anchorRef = useRef(sessionStart);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  useEffect(() => {
    const id = setInterval(() => {
      const next = currentCmeSessionStart();
      if (next === anchorRef.current) return;
      anchorRef.current = next;
      setSessionStart(next);
      refreshAllTrades(accountRef.current ?? undefined);
    }, SESSION_ANCHOR_RECHECK_MS);
    return () => clearInterval(id);
  }, []);
  return sessionStart;
}

/**
 * Hook variant — fetches its own trade list scoped to an account.
 * Components that already render `useTrades` for the same account can
 * pass the cached list to `selectLivePnL` (below) instead, to avoid
 * duplicating the polling subscription.
 */
export function useLivePnL(accountId: number | null | undefined, scope: PnLScope = "session") {
  const { trades } = useTrades({ accountId: accountId ?? null });
  const trading = useTrading();
  const { deployments } = useDeployments();
  const sessionStart = useCmeSessionStart(accountId);

  // Practice toggle scopes every PnL surface: when ON, only PRAC accounts
  // count; when OFF, only live accounts count. The visible-account set
  // already encodes this rule, so we just filter trades + positions +
  // unrealized rollups against it instead of re-deriving practice-ness.
  const visibleAccountIds = useMemo(
    () => new Set(trading.visibleAccounts.map((a) => a.id)),
    [trading.visibleAccounts],
  );

  return useMemo(() => {
    const visibleTrades = trades.filter((t) => visibleAccountIds.has(t.accountId));
    const visiblePositions = trading.positions.filter((p) => visibleAccountIds.has(p.accountId));
    const visibleDeployments = deployments.filter((d) => visibleAccountIds.has(d.accountId));

    return buildSelectors({
      trades: visibleTrades,
      positions: visiblePositions,
      unrealizedForPosition: trading.unrealizedForPosition,
      deployments: visibleDeployments,
      sessionStart,
      scope,
    });
  }, [
    trades,
    trading.positions,
    trading.unrealizedForPosition,
    deployments,
    visibleAccountIds,
    sessionStart,
    scope,
  ]);
}

interface BuildArgs {
  trades: StrategyTrade[];
  positions: ReturnType<typeof useTrading>["positions"];
  unrealizedForPosition: ReturnType<typeof useTrading>["unrealizedForPosition"];
  deployments: DeploymentLite[];
  sessionStart: string;
  scope: PnLScope;
}

/** Exported for its test; every surface reaches it through `useLivePnL`. */
export function buildSelectors(args: BuildArgs) {
  const { trades, positions, unrealizedForPosition,
          deployments, sessionStart, scope } = args;

  /** Per-deployment roll-up over the trade list. Fees + realized + count
   *  in one walk. */
  const byDeployment = new Map<string, { realized: number; fees: number; closedCount: number }>();
  const deploymentsById = new Map<string, DeploymentLite>();
  for (const d of deployments) deploymentsById.set(d.id, d);
  for (const t of trades) {
    if (!isInScope(t, scope, sessionStart)) continue;
    // A trade closed on an account the deployment has since moved off is
    // the old account's, not this row's: the `R:` chip reads only the
    // current account's trades, as the trade list already does
    // ("Trade history / PnL persists across account reassignment").
    if (deploymentsById.get(t.deploymentId)?.accountId !== t.accountId) continue;
    const bucket = byDeployment.get(t.deploymentId) ?? { realized: 0, fees: 0, closedCount: 0 };
    bucket.realized += t.pnlDollars ?? 0;
    bucket.fees += t.feesDollars ?? 0;
    bucket.closedCount += 1;
    byDeployment.set(t.deploymentId, bucket);
  }

  /** Per-deployment open position lookup. A deployment "owns" a broker
   *  position iff it has an open trade row matching the same
   *  (accountId, contractId). Matching by ticker substring alone causes
   *  misattribution when two deployments target the same contract on one
   *  account: both claim the same broker position even though only one
   *  actually placed it. The open-trade row is the engine's source of truth
   *  for ownership. */
  const openByDeployment = new Map<string, ReturnType<typeof useTrading>["positions"][number]>();
  const openTradesByDeployment = new Map<string, StrategyTrade>();
  for (const t of trades) {
    if (t.status !== "open" && t.status !== "pending_entry" && t.status !== "pending_exit") continue;
    if (!openTradesByDeployment.has(t.deploymentId)) openTradesByDeployment.set(t.deploymentId, t);
  }
  for (const d of deployments) {
    const ownTrade = openTradesByDeployment.get(d.id);
    if (!ownTrade) continue;
    const pos = positions.find(
      (p) => p.accountId === d.accountId && p.contractId === ownTrade.contractId,
    );
    if (pos) openByDeployment.set(d.id, pos);
  }

  /** The position a deployment holds, as an `(accountId, contractId)` key, or
   *  null when it holds none. A filled row (`open`, or `pending_exit` on its
   *  way out) holds one whether or not the broker read matched it: a failed
   *  match is a key mismatch or a cold read, never a confirmation of flat, and
   *  answering flat let the chip and the page count contradict the row. A
   *  `pending_entry` row holds one only once the broker shows it. Keyed on the
   *  row's contract, which a matched position shares by construction, so the
   *  dedupe below is the same whether the match landed or not. */
  function heldPositionKey(d: DeploymentLite): string | null {
    const ownTrade = openTradesByDeployment.get(d.id);
    if (!ownTrade) return null;
    if (!openByDeployment.has(d.id) && ownTrade.status === "pending_entry") return null;
    return `${d.accountId}:${ownTrade.contractId}`;
  }

  /** A held deployment's unrealized, `null` when nothing prices it — an
   *  unmatched position, or a matched one with no mark. `0` when it holds none. */
  function heldUnrealized(d: DeploymentLite): number | null {
    if (heldPositionKey(d) == null) return 0;
    const livePos = openByDeployment.get(d.id);
    return livePos ? unrealizedForPosition(livePos) : null;
  }

  /** Unrealized over the positions `held` names, each once, and whether any
   *  was named. One unpriced position makes the whole figure `null`. */
  function rollUpHeld(held: DeploymentLite[]): { unrealized: number | null; hasOpenPosition: boolean } {
    const seenPositions = new Set<string>();
    let unrealized: number | null = 0;
    for (const d of held) {
      const key = heldPositionKey(d);
      if (key == null || seenPositions.has(key)) continue;
      seenPositions.add(key);
      const one = heldUnrealized(d);
      unrealized = unrealized == null || one == null ? null : unrealized + one;
    }
    return { unrealized, hasOpenPosition: seenPositions.size > 0 };
  }

  function deployment(id: string): PnLBreakdown {
    const d = deploymentsById.get(id);
    if (!d) return emptyBreakdown();
    const closedBucket = byDeployment.get(id) ?? { realized: 0, fees: 0, closedCount: 0 };
    const unrealized = heldUnrealized(d);
    return {
      realized: closedBucket.realized,
      unrealized,
      fees: closedBucket.fees,
      total: plus(closedBucket.realized, unrealized),
      closedCount: closedBucket.closedCount,
      hasOpenPosition: heldPositionKey(d) != null,
    };
  }

  function account(id: number): PnLBreakdown {
    // Deployment-only on BOTH sides: realized from strategy_trades and
    // unrealized from positions matched to enabled deployments. Manual
    // webapp trades are intentionally excluded from every PnL surface.
    let realized = 0;
    let fees = 0;
    let closedCount = 0;
    for (const t of trades) {
      if (t.accountId !== id) continue;
      if (!isInScope(t, scope, sessionStart)) continue;
      realized += t.pnlDollars ?? 0;
      fees += t.feesDollars ?? 0;
      closedCount += 1;
    }
    // Dedupe by position: multiple deployments on the same account can map
    // to the same broker position (same ticker), and unrealized belongs to
    // the position, not the deployment. Sum each position once.
    const { unrealized, hasOpenPosition } = rollUpHeld(deployments.filter((d) => d.accountId === id));
    return {
      realized,
      unrealized,
      fees,
      total: plus(realized, unrealized),
      closedCount,
      hasOpenPosition,
    };
  }

  function allAccounts(): PnLBreakdown {
    let realized = 0;
    let fees = 0;
    let closedCount = 0;
    for (const t of trades) {
      if (!isInScope(t, scope, sessionStart)) continue;
      realized += t.pnlDollars ?? 0;
      fees += t.feesDollars ?? 0;
      closedCount += 1;
    }
    // Same dedupe rule as account(): one broker position contributes its
    // unrealized once even when several deployments map to it.
    const { unrealized, hasOpenPosition } = rollUpHeld(deployments);
    return {
      realized,
      unrealized,
      fees,
      total: plus(realized, unrealized),
      closedCount,
      hasOpenPosition,
    };
  }

  function accountBuckets(id: number): BucketBreakdown {
    const out: BucketBreakdown = { active: 0, retired: 0, trashed: 0, manual: 0 };
    for (const t of trades) {
      if (t.accountId !== id) continue;
      if (!isInScope(t, scope, sessionStart)) continue;
      const b: TradeBucket = t.bucket ?? "active";
      out[b] += t.pnlDollars ?? 0;
    }
    return out;
  }

  function allAccountsBuckets(): BucketBreakdown {
    const out: BucketBreakdown = { active: 0, retired: 0, trashed: 0, manual: 0 };
    for (const t of trades) {
      if (!isInScope(t, scope, sessionStart)) continue;
      const b: TradeBucket = t.bucket ?? "active";
      out[b] += t.pnlDollars ?? 0;
    }
    return out;
  }

  /** All deployments of the same strategy on a single account. */
  function strategy(strategyKey: string, accountId: number): PnLBreakdown {
    let realized = 0;
    let fees = 0;
    let closedCount = 0;
    const legs = deployments.filter((d) => d.accountId === accountId && d.strategyKey === strategyKey);
    for (const d of legs) {
      const b = deployment(d.id);
      realized += b.realized;
      fees += b.fees;
      closedCount += b.closedCount;
    }
    const { unrealized, hasOpenPosition } = rollUpHeld(legs);
    return { realized, unrealized, fees, total: plus(realized, unrealized), closedCount, hasOpenPosition };
  }

  /**
   * Distinct broker positions the deployments own, across every visible
   * account. Deduped by `(accountId, contractId)` on exactly the rule
   * `account()` and `allAccounts()` dedupe unrealized by — a position
   * belongs to the position, not to the deployment that matched it.
   *
   * **The board's session strip reads this and never folds the cards.**
   * `BoardDeployment.openPositionCount` counts *legs*, so summing it over a
   * board where two cards map to one broker position reports two, the same
   * way summing their `sessionPnl` would double-count that position's
   * unrealized. The strip is a page-level figure and takes a page-level
   * reducer.
   */
  function openPositionCount(): number {
    const seen = new Set<string>();
    for (const d of deployments) {
      const key = heldPositionKey(d);
      if (key != null) seen.add(key);
    }
    return seen.size;
  }

  return {
    account,
    accountBuckets,
    deployment,
    strategy,
    allAccounts,
    allAccountsBuckets,
    openPositionCount,
  };
}
