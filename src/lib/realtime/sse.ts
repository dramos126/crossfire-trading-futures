import { registerAfterCloseHook } from "@/lib/db/connection";
import type { BroadcastEvent } from "./event-broadcaster";
import { SSE_HEARTBEAT_MS } from "./sse-heartbeat";

/**
 * The wire form of the broadcaster's events, and the lifecycle of a response
 * that relays them. Two streams send it — the browser's `/api/engine/stream`
 * and the engine process's `/api/internal/engine/events` — and the web
 * process's remote engine handle reads it back, so the writer and the reader
 * live here together.
 */

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  // `close`, not `keep-alive`: when the shutdown ends this stream the
  // socket must close with it. `server.close()` sweeps idle keep-alive
  // sockets once, at the call, and the end lands after it — a socket
  // that went idle later held the stop to the full grace (Node 22,
  // measured). A stream outlives any reuse the client would make of it.
  Connection: "close",
  // Disable Nginx proxy buffering if fronted by it — otherwise SSE
  // frames sit in the proxy buffer and the client sees them in
  // batches. No-op in environments without Nginx.
  "X-Accel-Buffering": "no",
};

/**
 * Every open stream's teardown, so a SIGTERM can end them all.
 *
 * **An open SSE response is what kept every deploy's stop at the full
 * `docker stop` grace.** Next's SIGTERM handler awaits `server.close()`,
 * which closes idle keep-alive sockets once and then waits for the rest;
 * a stream never goes idle, so the process sat until SIGKILL. Ending them
 * runs in the DB shutdown's after-close phase, so it can only ever follow
 * the clean-shutdown marker. It is a release, not an action: it places no
 * order and touches no position. Parked on `globalThis` because a route's
 * module graph is not the one `instrumentation.ts` loaded, and `next dev`
 * re-evaluates it.
 */
interface OpenStreams {
  ends: Set<() => void>;
  hookRegistered: boolean;
}
const OPEN_STREAMS_KEY = "__crossfireOpenSseStreams";
type GlobalWithStreams = typeof globalThis & { [OPEN_STREAMS_KEY]?: OpenStreams };

export function openSseStreams(): OpenStreams {
  const g = globalThis as GlobalWithStreams;
  const streams = (g[OPEN_STREAMS_KEY] ??= { ends: new Set(), hookRegistered: false });
  if (!streams.hookRegistered) {
    streams.hookRegistered = true;
    registerAfterCloseHook(() => {
      for (const end of [...streams.ends]) end();
    });
  }
  return streams;
}

/** Serialize a broadcaster event as an SSE frame. Uses `event:` + `data:`
 *  so the client can dispatch by event name without parsing. */
export function formatSseEvent(event: BroadcastEvent): string {
  const data = JSON.stringify(event);
  return `event: ${event.kind}\ndata: ${data}\n\n`;
}

const FRAME_END = "\n\n";
const DATA_FIELD = "data:";

function asBroadcastEvent(data: string): BroadcastEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { kind?: unknown }).kind === "string") {
      return parsed as BroadcastEvent;
    }
  } catch {
    // Not JSON: not one of ours, dropped like a comment.
  }
  return null;
}

/**
 * The events in every complete frame of `buffer`, and the incomplete tail to
 * carry into the next read. Comments (the padding, the heartbeat) and frames
 * whose data is not an event are dropped; the event's own `kind` is read
 * from its data, so the `event:` line is not consulted.
 */
export function parseSseEvents(buffer: string): { events: BroadcastEvent[]; rest: string } {
  const frames = buffer.replace(/\r\n/g, "\n").split(FRAME_END);
  const rest = frames.pop() ?? "";
  const events: BroadcastEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith(DATA_FIELD))
      .map((line) => line.slice(DATA_FIELD.length).trimStart())
      .join("\n");
    const event = data ? asBroadcastEvent(data) : null;
    if (event) events.push(event);
  }
  return { events, rest };
}

export interface BroadcastStreamSpec {
  /** The request's own signal: the client leaving ends the stream. */
  signal: AbortSignal;
  /** Frames sent before anything is subscribed, in order. */
  opening: string[];
  subscribe(listener: (event: BroadcastEvent) => void): Promise<() => void>;
  /** Runs once the listener is in place; a rejection is said as a
   *  disconnected `status` frame and the stream stays open. */
  afterSubscribe?: () => Promise<void>;
}

function disconnectedFrame(err: unknown): string {
  return formatSseEvent({
    kind: "status",
    connected: false,
    reason: err instanceof Error ? err.message : String(err),
  });
}

/**
 * A response body relaying broadcaster events: the opening frames, a
 * heartbeat, every event the subscription delivers, and one teardown that the
 * client's abort, a failed subscribe and the SIGTERM shutdown all run.
 */
export function broadcastEventStream(spec: BroadcastStreamSpec): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client disconnected) — swallow.
          closed = true;
        }
      };

      for (const frame of spec.opening) safeEnqueue(frame);

      // Heartbeat so intermediate proxies don't close an idle stream.
      // Clients ignore comments, only react to `event:` frames.
      const heartbeat = setInterval(() => {
        safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
      }, SSE_HEARTBEAT_MS);

      // Tracked before the awaits below, so a SIGTERM that lands while the
      // listener or the user hub is still coming up ends this stream too.
      let unsubscribe: (() => void) | null = null;
      let cleanedUp = false;
      const streams = openSseStreams();
      // Guarded on `cleanedUp`, not `closed`: a failed enqueue sets `closed`
      // first, and the heartbeat and the listener must still be released.
      const cleanup = () => {
        streams.ends.delete(cleanup);
        if (cleanedUp) return;
        cleanedUp = true;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      streams.ends.add(cleanup);

      // Client-initiated disconnect, bound before the awaits below: a client
      // that left while the user hub was coming up would otherwise never run
      // `cleanup`, leaking its heartbeat and its entry in `streams.ends`. An
      // abort that already fired never reaches a listener added after it.
      spec.signal.addEventListener("abort", cleanup);
      if (spec.signal.aborted) {
        cleanup();
        return;
      }

      // The subscribe builds the relay, and can reject after an opening
      // status frame said connected — credentials cleared by a settings
      // reset, a failed token refresh. Say so and end the stream, or the
      // heartbeat outlives it for the life of the process.
      let off: () => void;
      try {
        off = await spec.subscribe((event) => {
          safeEnqueue(formatSseEvent(event));
        });
      } catch (err) {
        safeEnqueue(disconnectedFrame(err));
        cleanup();
        return;
      }
      // A stop or a disconnect that landed during the subscribe had no
      // listener to release yet.
      if (cleanedUp) {
        off();
        return;
      }
      unsubscribe = off;

      if (!spec.afterSubscribe) return;
      try {
        await spec.afterSubscribe();
      } catch (err) {
        safeEnqueue(disconnectedFrame(err));
      }
    },
  });
}
