import { NextRequest } from "next/server";
import { localEngineHandle } from "@/lib/trading/engine/handle/local";
import { broadcastEventStream, formatSseEvent, SSE_HEADERS } from "@/lib/realtime/sse";
import { errorAnswer, refuseInternalRequest, thrownAnswer } from "../internal-gate";

const handle = localEngineHandle();

const STATUS_UNAVAILABLE = 503;
const REALTIME_DISABLED = "RealtimeFeedDisabled";

/**
 * `GET /api/internal/engine/events`: every broadcaster event, in the frame
 * shape the browser's `/api/engine/stream` sends, for a `web` process's one
 * upstream connection. It subscribes to every event and asks the relay for
 * no account or contract — a web process's browsers do that through
 * `ensureRunning`, a call. Same gate as the calls; ended by the SIGTERM
 * shutdown set like the browser's stream.
 */
export async function GET(req: NextRequest) {
  const refused = refuseInternalRequest(req);
  if (refused) return refused;

  let connected: boolean | null;
  try {
    connected = await handle.getConnectedState();
  } catch (err) {
    return thrownAnswer(err);
  }
  if (connected === null) {
    return errorAnswer(STATUS_UNAVAILABLE, REALTIME_DISABLED, "the engine has no realtime transport to relay from");
  }

  const listenerKey = `internal-${crypto.randomUUID()}`;
  const stream = broadcastEventStream({
    signal: req.signal,
    opening: [formatSseEvent({ kind: "status", connected })],
    subscribe: (listener) => handle.subscribeEvents(listenerKey, listener),
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
