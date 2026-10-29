import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { broadcastEventStream, formatSseEvent, SSE_HEADERS } from "@/lib/realtime/sse";

const handle = engineHandle();

/**
 * Server-Sent Events endpoint that relays the engine's user-hub + market-hub
 * events to the browser.
 *
 * Why this exists: Topstep enforces a single SignalR session per user, and
 * the engine already owns it (needs market-hub for sub-second strategy
 * reactions). The browser can't open its own hub without kicking the
 * engine, so we forward the engine's stream here.
 *
 * Transport choice: SSE via `fetch` + ReadableStream rather than raw
 * `EventSource`. EventSource can't set custom headers, which would force
 * us to pass the session token in the query string — logs, reverse-proxies,
 * and browser history would all capture it. Streaming fetch supports the
 * same `text/event-stream` format with a proper `x-session-token` header.
 * Do not "simplify" this into a query param; the header is uniform across
 * every call site precisely so there is no exception to re-audit.
 *
 * Body (POST) — accepted either as JSON or via query params:
 *   { accountIds: number[], contractIds: string[] }
 *
 * accountIds determines which accounts' orders/positions/trades we
 * subscribe to on the user hub. contractIds gets trade-subscribed on the
 * market hub so the browser receives marketTrade ticks for unrealized-PnL.
 *
 * The stream's lifecycle — heartbeat, the SIGTERM shutdown set, abort and
 * failed-subscribe cleanup — is `broadcastEventStream`'s, shared with the
 * engine process's internal events stream.
 */

interface StreamRequestBody {
  accountIds?: number[];
  contractIds?: string[];
}

export async function POST(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;

  let body: StreamRequestBody;
  try {
    body = (await req.json()) as StreamRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
  const contractIds = Array.isArray(body.contractIds) ? body.contractIds : [];

  // `getConnectedState()` builds the engine before the broadcaster — the
  // engine is what builds the realtime transports the relay reads from.
  // Without them there is no relay, the answer is null, and we 503 so the
  // client falls back to REST polling.
  let connected: boolean | null;
  try {
    connected = await handle.getConnectedState();
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Engine unavailable",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  if (connected === null) {
    return new Response(
      JSON.stringify({ error: "Realtime feed disabled (USE_REALTIME_BARS=false)" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // Unique key per subscriber so add/remove doesn't rely on function identity.
  // randomUUID() avoids the collision risk of base36-of-Math.random when many
  // subscribers connect in the same millisecond (e.g. multi-tab refresh).
  const listenerKey = `sse-${crypto.randomUUID()}`;

  const stream = broadcastEventStream({
    signal: req.signal,
    opening: [
      // A 2KB padding comment first. Small SSE frames (~50 bytes each)
      // often sit in browser/proxy buffers until the buffer fills —
      // observed in dev, where the stream stayed open on the wire but the
      // client never saw the initial `status` frame, so the UI stayed in
      // "Polling" mode until the stream closed and re-opened via refresh.
      // Padding past the typical 2KB buffer threshold forces a flush.
      ":" + " ".repeat(2048) + "\n\n",
      `: connected ${listenerKey}\n\n`,
      // Tells the browser whether the user hub is actually up, so the UI
      // can decide between "live" and "polling" modes from the first message.
      formatSseEvent({ kind: "status", connected }),
    ],
    subscribe: (listener) => handle.subscribeEvents(listenerKey, listener),
    // Start (or re-use) the broadcaster's user hub and subscribe to the
    // requested accounts/contracts. If the hub was already up for another
    // browser, ensureRunning is a cheap incremental subscribe.
    afterSubscribe: () => handle.ensureRunning(accountIds, contractIds),
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
