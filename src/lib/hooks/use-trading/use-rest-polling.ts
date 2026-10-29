"use client";

import { useEffect, type Dispatch, type MutableRefObject } from "react";
import type { Contract } from "@/lib/brokers/types";
import type { Action, ContractMeta, QuoteSnapshot } from "./types";

interface UseRestPollingArgs {
  token: string | null;
  refreshAccount: (token: string, accountId: number) => Promise<void>;
  dispatch: Dispatch<Action>;
  tokenRef: MutableRefObject<string | null>;
  targetAccountIdsRef: MutableRefObject<number[]>;
  openContractIdsRef: MutableRefObject<string[]>;
  contractMetaRef: MutableRefObject<Record<string, ContractMeta>>;
  liveRef: MutableRefObject<boolean>;
  /** When the stream last marked each contract (`Date.now()` at receipt). */
  streamMarksRef: MutableRefObject<Map<string, number>>;
}

// ── REST polling ─────────────────────────────────────────────────────
//
// The browser ingests from the SSE stream; this loop is what is left of
// polling, and each read in it runs only where the stream cannot vouch for
// the data. The loop ticks every 2.5s and each consumer decides:
//   - positions: every tick while the stream is down, every 4th (10s) while
//     it is up — the user hub does not reliably send a size-0 close, so a
//     live stream can still hold a position the broker has closed
//   - quotes: on the same reconcile tick, for every open contract while the
//     stream is down and, while it is up, only for a contract the stream has
//     not marked inside QUOTE_STREAM_QUIET_MS — an alias the relay could not
//     resolve leaves the stream silent on that one contract (bugs.md)
//   - contract meta: lazily, once per id missing from the cache (per-id
//     backoff below) — static data the stream does not carry
const FAST_POLL_MS = 2500;
/** A contract the stream has not marked for this long is quoted over REST
 *  even while the stream is up. Three reconcile ticks: a contract trading at
 *  all ticks well inside it, so a live mark never pays for the read. */
export const QUOTE_STREAM_QUIET_MS = 30_000;

/** The open contracts this reconcile asks `/api/quotes` about. */
export function contractsNeedingQuote(
  contracts: readonly string[],
  live: boolean,
  streamMarks: ReadonlyMap<string, number>,
  now: number,
): string[] {
  if (!live) return [...contracts];
  return contracts.filter((id) => {
    const markedAt = streamMarks.get(id);
    return markedAt === undefined || now - markedAt >= QUOTE_STREAM_QUIET_MS;
  });
}
// When SSE is healthy, positions/orders only need to be reconciled
// periodically (Topstep's user hub doesn't reliably emit size-0 close
// events, but a 10s safety net is plenty). Poll every Nth fast tick to
// stay well under Topstep's REST rate limit — at 7 visible accounts the
// 2.5s cadence pushed us into 429 territory on /api/Order/searchOpen.
const RECONCILE_EVERY_N_TICKS_LIVE = 4; // 4 × 2.5s = 10s

// ── Contract-meta retry backoff ──────────────────────────────────────
//
// The meta loop below asks only for ids missing from the cache, and a
// failed lookup leaves the id missing — so *any* failure (404 spec-not-
// found, auth error, timeout) is re-asked on the very next tick, every
// 2.5s, indefinitely. That is what turned a cosmetic lookup into the
// self-sustaining loop that hammered Tradovate's auth endpoint into the
// broker-unavailable circuit and auto-paused deployments.
//
// Back off per id rather than blacklisting one: a miss here is not proof
// the contract is unresolvable. The route's dated-symbol arm answers out
// of the engine's contract cache, which warms *after* the browser starts
// asking, so an id that misses on an early tick is genuinely expected to
// resolve on a later one — and the meta table drives the symbol→contractId
// join for SSE quotes, so giving up on one permanently costs live marks.
// Hence: retry after 2, 4, 8 … ticks up to a cap, and never give up. A
// spec that truly does not exist settles at one request every 5 minutes
// instead of 24 a minute.
const META_RETRY_MAX_TICKS = 120; // 5 min at FAST_POLL_MS

export interface ContractMetaRetry {
  /** True when `id` may be requested on this tick. */
  isDue(id: string, tick: number): boolean;
  /** Claim the next slot for `id` *before* the request goes out, so a
   *  lookup slower than the poll cadence cannot be re-fired underneath it. */
  reserve(id: string, tick: number): void;
  /** Forget `id`'s backoff — it resolved. */
  clear(id: string): void;
  /** Forget every id not in `openIds`, so a tab left open for days does
   *  not accumulate an entry per contract it ever held. */
  retain(openIds: readonly string[]): void;
}

export function createContractMetaRetry(): ContractMetaRetry {
  const attempts = new Map<string, { failures: number; retryAtTick: number }>();
  return {
    isDue(id, tick) {
      const entry = attempts.get(id);
      return entry === undefined || tick >= entry.retryAtTick;
    },
    reserve(id, tick) {
      const failures = (attempts.get(id)?.failures ?? 0) + 1;
      const delay = Math.min(2 ** failures, META_RETRY_MAX_TICKS);
      attempts.set(id, { failures, retryAtTick: tick + delay });
    },
    clear(id) {
      attempts.delete(id);
    },
    retain(openIds) {
      const open = new Set(openIds);
      for (const id of attempts.keys()) {
        if (!open.has(id)) attempts.delete(id);
      }
    },
  };
}

export function useRestPolling({
  token,
  refreshAccount,
  dispatch,
  tokenRef,
  targetAccountIdsRef,
  openContractIdsRef,
  contractMetaRef,
  liveRef,
  streamMarksRef,
}: UseRestPollingArgs): void {
  useEffect(() => {
    if (!token) return;

    let stopped = false;
    let tickCount = 0;
    const metaRetry = createContractMetaRetry();

    // One cadence covers both the position reconcile and the quote read:
    // both are backstops for something the stream should have carried, and
    // splitting them is what let the quote half be skipped entirely.
    //
    // A hidden tab does not tick at all: the operator keeps up to three tabs
    // open and nobody is reading the background ones. Coming back to the
    // foreground ticks once, immediately, with a reconcile — what the
    // operator looks at must be current, not one interval old.
    const fastTick = async (resumed = false) => {
      if (stopped) return;
      if (document.visibilityState !== "visible") return;
      const tk = tokenRef.current;
      const accounts = targetAccountIdsRef.current;
      if (!tk || accounts.length === 0) return;

      const live = liveRef.current;
      tickCount++;
      const shouldReconcile = resumed || !live || tickCount % RECONCILE_EVERY_N_TICKS_LIVE === 0;
      if (shouldReconcile) {
        await Promise.all(accounts.map((id) => refreshAccount(tk, id)));
      }

      const contracts = openContractIdsRef.current;
      metaRetry.retain(contracts);
      const marks = streamMarksRef.current;
      for (const id of marks.keys()) if (!contracts.includes(id)) marks.delete(id);
      if (contracts.length === 0) return;

      // Gated per contract, never on `live` alone: that made the stream a
      // single point of failure for unrealized PnL, which is what left a
      // Tradovate position marked at "—" for its whole life (bugs.md).
      const quoting = shouldReconcile
        ? contractsNeedingQuote(contracts, live, marks, Date.now())
        : [];
      if (quoting.length > 0) {
        try {
          const res = await fetch("/api/quotes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contractIds: quoting }),
          });
          const data = (await res.json()) as { quotes?: Record<string, QuoteSnapshot> };
          if (res.ok && data.quotes) {
            dispatch({ type: "QUOTES_LOADED", quotes: data.quotes });
          }
        } catch {
          // transient
        }
      }

      // Lazy-load contract meta for any contract we don't have yet.
      // Runs in both live and polling modes — the meta table powers the
      // symbol→contractId join for incoming SSE quote events. Falsy ids
      // (empty string, undefined) come from in-flight or just-closed
      // positions where contractId hasn't propagated yet — skip them so
      // we don't hammer /api/contracts/by-id with 400s on every tick.
      // Ids still inside their retry backoff are skipped — see
      // META_RETRY_MAX_TICKS above for why a miss backs off rather than
      // sticking.
      const meta = contractMetaRef.current;
      const missing = contracts.filter((id) => id && !meta[id] && metaRetry.isDue(id, tickCount));
      for (const id of missing) {
        metaRetry.reserve(id, tickCount);
        fetch("/api/contracts/by-id", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contractId: id }),
        })
          .then((r) => r.json())
          .then((data: { contract?: Contract }) => {
            if (data.contract) {
              metaRetry.clear(id);
              dispatch({
                type: "CONTRACT_META",
                contractId: id,
                meta: {
                  tickSize: data.contract.tickSize,
                  tickValue: data.contract.tickValue,
                  name: data.contract.name,
                },
              });
            }
          })
          .catch(() => {});
      }
    };

    void fastTick();
    const fastId = setInterval(() => void fastTick(), FAST_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fastTick(true);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      clearInterval(fastId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token, refreshAccount, tokenRef, targetAccountIdsRef, openContractIdsRef, contractMetaRef, liveRef, streamMarksRef, dispatch]);
}
