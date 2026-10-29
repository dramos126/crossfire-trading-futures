"use client";

import { useEffect, useMemo, type Dispatch, type MutableRefObject } from "react";
import type { Position } from "@/lib/brokers/types";
import { refreshAllTrades } from "@/lib/hooks/use-trades";
import { DeploymentsReadError, refreshDeployments } from "@/lib/hooks/use-strategies";
import { clearSetupReadings, refreshSetupReadings } from "@/lib/hooks/use-setup-readings";
import { applyEngineStatus } from "@/lib/hooks/use-engine-status";
import { publishLogLine } from "@/lib/hooks/log-line-feed";
import { SSE_IDLE_MS } from "@/lib/realtime/sse-heartbeat";
import { SESSION_REFUSED_STATUS, type Action } from "./types";

interface UseSseStreamArgs {
  token: string | null;
  targetAccountIds: number[];
  openContractIds: string[];
  targetAccountIdsRef: MutableRefObject<number[]>;
  openContractIdsRef: MutableRefObject<string[]>;
  /** Written on every `marketTrade` frame; the quote fallback reads it. */
  streamMarksRef: MutableRefObject<Map<string, number>>;
  dispatch: Dispatch<Action>;
}

export function useSseStream({
  token,
  targetAccountIds,
  openContractIds,
  targetAccountIdsRef,
  openContractIdsRef,
  streamMarksRef,
  dispatch,
}: UseSseStreamArgs): void {
  // ── SSE live stream ──────────────────────────────────────────────────
  //
  // Connects to /api/engine/stream, the one channel the browser ingests
  // from: hub events the engine's SignalR session is already getting, and
  // the engine's own status, log lines and invalidations. While it is up,
  // `state.live` is true and the surfaces that used to poll stop; when it
  // drops they fall back to polling until it returns.
  //
  // Transport is `fetch` + ReadableStream. It was chosen because EventSource
  // could not set the session header; the session is a cookie now, which
  // rides either, so the reason is gone but the reader works and swapping
  // it is a change of its own. Never a query-string token: it would leak
  // into logs, reverse-proxy access lines and browser history.
  useEffect(() => {
    if (!token) return;
    // **No `hasTargetAccounts` gate.** `deploymentsChanged` is a global frame
    // the relay forwards to every subscriber, and `accountIds` only drives
    // `ensureRunning`'s hub subscriptions — the route coerces a missing list
    // to `[]` and `broadcaster.subscribe` fans events to the listener before
    // `ensureRunning` is called at all. Gating the stream on the account set
    // meant a board with nothing engine-managed had no lifecycle channel, so
    // a deployment created or settled elsewhere never reached the tab.

    const controller = new AbortController();
    let cancelled = false;
    let activeRead = false;
    // Ends the read in flight: the idle watchdog and a resume both go through
    // here. Null while no reader is open. Not `controller.abort()`, which
    // would stop every future retry too.
    let dropRead: (() => void) | null = null;
    let reading: Promise<void> = Promise.resolve();

    const consume = async () => {
      if (activeRead) return; // guard against overlapping retries
      activeRead = true;
      let idle: ReturnType<typeof setTimeout> | null = null;
      try {
        const res = await fetch("/api/engine/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountIds: targetAccountIdsRef.current,
            contractIds: openContractIdsRef.current,
          }),
          signal: controller.signal,
        });
        if (res.status === SESSION_REFUSED_STATUS) {
          // The route validates the session at connect and never per frame,
          // so a dead session is refused here and nowhere else on this path.
          dispatch({ type: "SESSION_REFUSED", token });
          return;
        }
        if (!res.ok || !res.body) {
          // 503 = feature unavailable (realtime bars off, or engine
          // not up yet). No point retrying — the polling path below
          // already covers this.
          dispatch({ type: "LIVE_STATUS", live: false });
          return;
        }

        // The setup readings are current only while this stream is open, so
        // they are read at the moment it opens and dropped in `finally`.
        void refreshSetupReadings();

        const reader = res.body.getReader();
        dropRead = () => void reader.cancel().catch(() => {});
        const decoder = new TextDecoder();
        let buffer = "";
        // A half-open connection never errors: `live` would stay true and
        // every surface would sit on its last value with no fallback timer.
        // Silence past the heartbeat's bound cancels the reader, so the
        // `finally` and the retry loop run as for any drop.
        const armIdle = () => {
          if (idle !== null) clearTimeout(idle);
          idle = setTimeout(() => dropRead?.(), SSE_IDLE_MS);
        };
        armIdle();

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by "\n\n". Loop in case one chunk
          // carries multiple frames.
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            handleSseFrame(frame);
          }
        }
      } catch {
        // Network error or abort — flip to offline and let the fallback
        // polling carry the UI until the reconnect loop below tries again.
      } finally {
        if (idle !== null) clearTimeout(idle);
        dropRead = null;
        activeRead = false;
        clearSetupReadings();
        if (!cancelled) dispatch({ type: "LIVE_STATUS", live: false });
      }
    };

    const handleSseFrame = (frame: string) => {
      // Frames we emit: "event: <kind>\ndata: <json>". Comments start
      // with ":" and are heartbeats — ignore them.
      if (frame.startsWith(":")) return;
      const lines = frame.split("\n");
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!dataLine) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        return;
      }
      const event = parsed as { kind?: string } & Record<string, unknown>;
      switch (event.kind) {
        case "status":
          dispatch({ type: "LIVE_STATUS", live: Boolean(event.connected) });
          break;
        case "position": {
          const p = event.payload as {
            id: number; accountId: number; contractId: string;
            creationTimestamp: string; type: Position["type"]; size: number; averagePrice: number;
          };
          dispatch({
            type: "LIVE_POSITION",
            position: {
              id: p.id,
              accountId: p.accountId,
              contractId: p.contractId,
              creationTimestamp: p.creationTimestamp,
              type: p.type,
              size: p.size,
              averagePrice: p.averagePrice,
            },
          });
          break;
        }
        case "marketTrade": {
          // Trade tick from the engine's market hub. lastPrice becomes the
          // mark for unrealized-PnL calc.
          const contractId = String(event.contractId);
          const lastPrice = Number(event.lastPrice);
          if (!contractId || !Number.isFinite(lastPrice)) break;
          streamMarksRef.current.set(contractId, Date.now());
          dispatch({
            type: "LIVE_QUOTE",
            contractId,
            snapshot: { mark: lastPrice, lastUpdated: String(event.timestamp) },
          });
          break;
        }
        // userTrade events still fire from Topstep's user hub on every
        // fill (including manual webapp trades), but we no longer track
        // an account-level realized total — PnL is computed from our own
        // strategy_trades only. Ignored here on purpose.
        case "strategyTrade": {
          // Engine just wrote a closeTrade(...) row. Force every active
          // useTrades subscription for this account to re-fetch so the
          // Strategies PnL pill, per-row PnL, and deployment-trades table
          // catch up to the hero's session realized in the same tick.
          const accountId = typeof event.accountId === "number" ? event.accountId : undefined;
          refreshAllTrades(accountId);
          break;
        }
        case "deploymentsChanged": {
          // A deployment was created, edited, paused, destroyed, settled or
          // orphaned somewhere else — this tab's store hydrates once on
          // mount and has no poll behind it, so without this it never finds
          // out. An invalidation, not a payload: refetch through the
          // endpoint that already owns the shape rather than patching a row
          // off the wire. Every rejection is caught — a failed refetch on a
          // 24/7 tab must not become an unhandled one — but a 401 is not
          // transient: after a reset or an expiry it is the only word this tab
          // gets that its session is dead, so it is handed to the provider.
          void refreshDeployments(token).catch((err: unknown) => {
            if (err instanceof DeploymentsReadError && err.status === SESSION_REFUSED_STATUS) {
              dispatch({ type: "SESSION_REFUSED", token });
            }
          });
          break;
        }
        case "setupsChanged":
          // A leg's ARMED reading changed. Same shape as above: re-read the
          // map from the route that owns it rather than patching off the wire.
          void refreshSetupReadings();
          break;
        case "tradesChanged":
          // A trade row was written — any row, any account.
          refreshAllTrades();
          break;
        case "engineStatus":
          applyEngineStatus(event.status);
          break;
        case "logLine":
          publishLogLine(event.record);
          break;
      }
    };

    // `activeRead` guards against overlapping attempts when a connect is
    // still in flight.
    const open = () => {
      if (controller.signal.aborted || activeRead) return;
      reading = consume();
    };
    open();

    // Retry loop: if the stream closes (engine down, network blip), wait
    // 30s and try again. Longer than a tight polling cadence because
    // rapid reconnects under a Topstep 429 just dig the hole deeper —
    // the REST polling below is the fallback carrying the UI in the
    // meantime.
    const retryId = setInterval(open, 30_000);

    // A page frozen in the background — a home-screen app on iOS freezes
    // the moment it leaves the foreground — comes back with this stream
    // half-open: no bytes, no error. Left to the idle bound and then the
    // retry interval, the status pill read Polling for up to ~90 s after
    // every return, while a Safari tab, which reloads on return, never
    // showed it (2026-10-28). Drop the read now and reopen the moment it
    // has let go; a stream that was in fact fine costs one reconnect.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (dropRead) {
        dropRead();
        void reading.then(open);
      } else {
        open();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(retryId);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
      dispatch({ type: "LIVE_STATUS", live: false });
    };
    // Token alone. Position/contract churn lives behind refs so the stream
    // opens once and keeps running across ordinary state updates — and it no
    // longer re-opens when the engine-managed set empties and refills, which
    // is what used to tear the lifecycle channel down mid-close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Ping /api/engine/subscriptions whenever the open-contract set changes
  // so the broadcaster's market-hub subscription list stays in sync. Without
  // this, a position opened by the engine *after* SSE mount would never
  // get quote events forwarded to the browser — unrealized PnL would
  // stick at "—" until the user refreshes. The endpoint dedupes so calling
  // it on every openContractIds change is cheap.
  const openContractsKey = useMemo(
    () => openContractIds.slice().sort().join(","),
    [openContractIds],
  );
  // **The account set is topped up here too, and that is not redundant with
  // the connect body.** The stream posts `accountIds` once, at connect, and
  // its effect now depends on `token` alone — so a set that arrives *after*
  // the session (the deployment store hydrates independently) would otherwise
  // be `[]` at the relay for the life of the tab. Keyed on the set's contents
  // rather than the array, which is new on every deployment refetch.
  const targetAccountsKey = useMemo(
    () => targetAccountIds.slice().sort((a, b) => a - b).join(","),
    [targetAccountIds],
  );
  useEffect(() => {
    if (!token) return;
    if (targetAccountIds.length === 0) return;
    void fetch("/api/engine/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `contractIds` is **omitted** when there are none, never sent as `[]`:
      // the route treats a present array as the whole open set and prunes
      // everything outside it, so an empty one would unsubscribe every
      // contract the relay is tracking. Absent prunes nothing.
      body: JSON.stringify(
        openContractIds.length > 0
          ? { accountIds: targetAccountIds, contractIds: openContractIds }
          : { accountIds: targetAccountIds },
      ),
    }).catch(() => {
      // Transient — REST polling fallback covers the gap.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, openContractsKey, targetAccountsKey]);
}
