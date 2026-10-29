"use client";

import { useContext, useEffect, useState, useCallback, useRef } from "react";
import type { StrategyTrade, PnLSummary, SlippageStats } from "@/lib/db/trade-types";
import type { DailyPnlGateStatus } from "@/app/api/trades/route";
import { TradingContext } from "@/lib/hooks/use-trading/use-trading-state";

export type { StrategyTrade, PnLSummary, SlippageStats, DailyPnlGateStatus };

interface TradesResponse {
  trades: StrategyTrade[];
  summary: PnLSummary;
  slippage: SlippageStats | null;
  /** Present only when scoped to a single deployment; null otherwise. */
  dailyPnlGate: DailyPnlGateStatus | null;
}

/** The re-read's cadence while the stream is down. While it is up, a
 *  `tradesChanged` or `strategyTrade` frame is what re-reads. */
export const TRADES_FALLBACK_MS = 5_000;

/**
 * Process-wide subscriber registry. Multiple components mounting `useTrades`
 * with the same query (e.g. one DeploymentTrades per active deployment on a
 * dashboard) share one subscription — one in-flight fetch, one fallback
 * interval while the stream is down — and each receives the latest snapshot
 * via its callback.
 */
interface Subscription {
  data: TradesResponse | null;
  inFlight: Promise<void> | null;
  /** An invalidation landed while a read was out. That read may have been
   *  answered before the write, and nothing polls behind it while the stream
   *  is up, so one more read follows it. */
  stale: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  /** Called on every settled fetch — `null` when it did not answer. See
   *  `refreshSub`. */
  subscribers: Set<(data: TradesResponse | null) => void>;
  /** Session token of the most recent subscriber. `/api/trades` is gated,
   *  so the registry has to carry one: `refreshAllTrades` fires from the
   *  SSE consumer, which has no hook context to read it from. */
  token: string | null;
}

const SUBS = new Map<string, Subscription>();

/** The reset value for `trades`, shared so a subscription-key change hands
 *  every consumer the same reference rather than a fresh `[]` that
 *  invalidates their memos for no reason. **Shared means every consumer holds
 *  the same array**, so one in-place `.sort()` downstream would corrupt the
 *  constant process-wide and silently — hence frozen, and hence `trades` is
 *  `readonly` all the way out to the table's props rather than the freeze
 *  being a runtime surprise nothing in the types warned about. */
const NO_TRADES: readonly StrategyTrade[] = Object.freeze([] as StrategyTrade[]);

/**
 * The subscription's identity, and the only place the query survives in a
 * recoverable form — `refreshAllTrades` re-derives the parameters by splitting
 * it. `deploymentIds` is already a comma-joined string by the time it gets
 * here (see the hook), so it holds no `|` and takes a slot of its own.
 *
 * **A present multi-leg filter is prefixed `#`, and that is structural rather
 * than decorative.** An absent filter and a filter naming *no* legs are
 * different questions — no filter matches every trade in the install, zero
 * legs match nothing — and joining an empty array gives `""`, the same fourth
 * slot an absent filter produces. The two would then share one subscription,
 * and `refreshAllTrades` would re-fetch the drill-in's scope as the board's
 * unfiltered one, rendering every trade in the install under one deployment's
 * header on every SSE trade frame. It cannot arise today only because
 * `buildBoard` never makes a card from zero legs — a fact three files away
 * that nothing here or in any type holds up. The server half already draws
 * this line (`IN (NULL)` versus no clause); the key draws it too.
 */
function subKey(
  accountId: number | null | undefined,
  deploymentId: string | undefined,
  slippageWindow: number | undefined,
  deploymentIds: string | undefined,
): string {
  const legs = deploymentIds == null ? "" : `#${deploymentIds}`;
  return `${accountId ?? ""}|${deploymentId ?? ""}|${slippageWindow ?? ""}|${legs}`;
}

async function fetchOnce(
  token: string | null,
  accountId: number | null | undefined,
  deploymentId: string | undefined,
  slippageWindow: number | undefined,
  deploymentIds: string | undefined,
): Promise<TradesResponse | null> {
  if (!token) return null;
  const params = new URLSearchParams();
  if (accountId != null) params.set("accountId", String(accountId));
  if (deploymentId) params.set("deploymentId", deploymentId);
  // Sent even when empty: the caller asked about a specific set of legs and
  // could not name one, which filters to nothing. Dropping the parameter
  // would widen the query to every trade in the install.
  if (deploymentIds != null) params.set("deploymentIds", deploymentIds);
  if (slippageWindow != null) params.set("slippageWindow", String(slippageWindow));
  try {
    const res = await fetch(`/api/trades?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as TradesResponse;
  } catch {
    return null;
  }
}

function refreshSub(key: string, sub: Subscription, accountId: number | null | undefined, deploymentId: string | undefined, slippageWindow: number | undefined, deploymentIds: string | undefined): Promise<void> {
  // Coalesce concurrent refresh calls: a burst of frames costs the read in
  // flight plus one trailing read, never one per frame and never fewer.
  if (sub.inFlight) {
    sub.stale = true;
    return sub.inFlight;
  }
  sub.inFlight = (async () => {
    do {
      sub.stale = false;
      const data = await fetchOnce(sub.token, accountId, deploymentId, slippageWindow, deploymentIds);
      // A fetch that did not answer keeps the last good snapshot — a blip
      // must not blank a table that is already showing rows — but it still
      // notifies, because a subscriber waiting on its *first* answer has to
      // learn that one came back empty-handed. That is the whole difference
      // between `…` (not yet) and `—` (there is no reading): without the
      // notification a 401 or a 500 leaves the surface telling the operator
      // to keep waiting forever.
      if (data) sub.data = data;
      for (const cb of sub.subscribers) cb(data);
    } while (sub.stale && SUBS.get(key) === sub);
  })().finally(() => {
    sub.inFlight = null;
  });
  return sub.inFlight;
}

export function useTrades(opts: {
  accountId?: number | null;
  deploymentId?: string;
  /**
   * Several deployments at once — one deployment's N legs, for the drill-in.
   *
   * Joined to a string before it reaches any dependency array, because an
   * array literal is a fresh reference every render and would tear the
   * subscription down and rebuild it on each one. Sorted so two callers
   * naming the same legs in a different order share one subscription.
   */
  deploymentIds?: readonly string[];
  slippageWindow?: number;
} = {}) {
  const { accountId, deploymentId, slippageWindow } = opts;
  const deploymentIds =
    opts.deploymentIds == null ? undefined : [...opts.deploymentIds].sort().join(",");
  // Read straight off the context rather than `useTrading()` so the hook
  // still renders (idle, tokenless) outside the provider.
  const trading = useContext(TradingContext);
  const token = trading?.token ?? null;
  const live = trading?.live ?? false;
  const [trades, setTrades] = useState<readonly StrategyTrade[]>([]);
  const [summary, setSummary] = useState<PnLSummary | null>(null);
  const [slippage, setSlippage] = useState<SlippageStats | null>(null);
  const [dailyPnlGate, setDailyPnlGate] = useState<DailyPnlGateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Not `!loading`: a failed first fetch ends the wait with `[]`, which is no
  // answer rather than *no open trades* — and the board hides rows on the
  // second reading only.
  const [tradesRead, setTradesRead] = useState(false);
  const subKeyRef = useRef<string>("");

  useEffect(() => {
    const key = subKey(accountId, deploymentId, slippageWindow, deploymentIds);
    // The key the previous run subscribed under. **"No cached snapshot" is not
    // the same fact as "the question changed"**, and only the second one may
    // clear the answer: `token` is a dep of this effect but not part of the
    // key, so a rotation — every `connect()`, including the board's Reconnect
    // button — tears the sub down (last subscriber out deletes it) and lands
    // here with the question unchanged. Resetting on that blanks a populated
    // board for a round trip, and a card whose `openTrades` went empty renders
    // a live position as flat with a structurally valid `$0.00` beside it.
    const prevKey = subKeyRef.current;
    subKeyRef.current = key;
    let sub = SUBS.get(key);
    if (!sub) {
      sub = {
        data: null,
        inFlight: null,
        stale: false,
        intervalId: null,
        subscribers: new Set(),
        token,
      };
      SUBS.set(key, sub);
    }
    sub.token = token;

    const onSettled = (data: TradesResponse | null) => {
      if (data) {
        setTrades(data.trades);
        setSummary(data.summary);
        setSlippage(data.slippage);
        setDailyPnlGate(data.dailyPnlGate ?? null);
        setTradesRead(true);
      }
      // Even a fetch that did not answer ends the *first* wait. `loading`
      // means "nothing has come back yet", not "the answer is late".
      setLoading(false);
    };
    sub.subscribers.add(onSettled);

    // Seed late subscribers from the cached snapshot so they don't wait on
    // the read below.
    if (sub.data) onSettled(sub.data);
    else if (prevKey !== "" && prevKey !== key) {
      // **A new key is a new question, and the old answer is not an answer to
      // it.** State lives per hook and is only written from a settled fetch,
      // so without this the previous scope's trades, summary and gate stay on
      // screen while `selection`, the scope label and the Account column
      // recompute synchronously — one round trip of all-accounts totals
      // printed under one leg's account name. If that fetch never lands, the
      // wrong account's figures persist indefinitely, and no banner on any
      // consumer of this hook watches `/api/trades`.
      setTrades(NO_TRADES);
      setSummary(null);
      setSlippage(null);
      setDailyPnlGate(null);
      setLoading(true);
      setTradesRead(false);
    }

    // `live` is a dependency, so this read is also the one a reconnecting
    // stream owes: frames sent while it was down are gone.
    void refreshSub(key, sub, accountId, deploymentId, slippageWindow, deploymentIds);
    if (live && sub.intervalId) {
      clearInterval(sub.intervalId);
      sub.intervalId = null;
    } else if (!live && !sub.intervalId) {
      sub.intervalId = setInterval(() => {
        const current = SUBS.get(key);
        if (!current) return;
        void refreshSub(key, current, accountId, deploymentId, slippageWindow, deploymentIds);
      }, TRADES_FALLBACK_MS);
    }

    return () => {
      const current = SUBS.get(key);
      if (!current) return;
      current.subscribers.delete(onSettled);
      if (current.subscribers.size === 0) {
        if (current.intervalId) clearInterval(current.intervalId);
        SUBS.delete(key);
      }
    };
  }, [accountId, deploymentId, slippageWindow, deploymentIds, token, live]);

  const refresh = useCallback(async () => {
    const sub = SUBS.get(subKeyRef.current);
    if (!sub) return;
    await refreshSub(subKeyRef.current, sub, accountId, deploymentId, slippageWindow, deploymentIds);
  }, [accountId, deploymentId, slippageWindow, deploymentIds]);

  return { trades, summary, slippage, dailyPnlGate, loading, tradesRead, refresh };
}

/**
 * Force-refresh every active /api/trades subscription. Called from the SSE
 * consumer on `tradesChanged` (every row write) and `strategyTrade` (a
 * close), which is what keeps every trade surface current while the stream
 * is up — nothing polls behind it then.
 *
 * `accountId` filters the broadcast: only refresh subscriptions that
 * either match the account or are unscoped (empty accountId in the key).
 */
export function refreshAllTrades(accountId?: number): void {
  for (const [key, sub] of SUBS.entries()) {
    if (accountId != null) {
      const [keyAccount] = key.split("|");
      if (keyAccount && keyAccount !== String(accountId)) continue;
    }
    // Re-derive params from the key so we don't need to track them on the sub.
    const [a, d, w, legs] = key.split("|");
    const acct = a ? Number(a) : null;
    const deployment = d || undefined;
    const window = w ? Number(w) : undefined;
    // The `#` prefix is what tells *no multi-leg filter* apart from *a filter
    // naming no legs* — see `subKey`. `#` alone unwraps to `""`, which
    // `fetchOnce` sends as `?deploymentIds=` and the route reads as an empty
    // set: matches nothing, which is the honest answer rather than the whole
    // install.
    const ids = legs.startsWith("#") ? legs.slice(1) : undefined;
    void refreshSub(key, sub, acct, deployment, window, ids);
  }
}
