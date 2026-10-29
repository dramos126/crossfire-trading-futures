import {
  projectLogRecord,
  setLogRingSink,
  type BurstUpdate,
  type RingLogEntry,
  type WireLogRecord,
} from "@/lib/logging/pipe";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
// Side-effect imports: each installs one of the log pipe's sinks at module
// load — the durable store and the Discord escalation sender. This module is
// what installs all three, so a module graph that has it has every sink.
import "@/lib/db/engine-logs";
import "@/lib/notify/log-escalation";

/**
 * The log pipe's sinks for this process, and the live rings `/logs` reads.
 *
 * **Light on purpose, and it must stay so.** The pipe keeps its sinks per
 * module graph, and a route graph reaches the engine only lazily through the
 * handle — so the handle imports this module statically to give every route
 * graph the sinks, and `engine-singleton` imports it for the boot graph. It
 * may not import `engine-singleton` or `engine.ts`: that would put the engine
 * graph back into the routes that only emit on the broadcaster.
 */

// Two independent ring buffers so heartbeats can never evict trade /
// error / connection events: one fires every `HEARTBEAT_MS`
// (engine-market-hub.ts) and would otherwise dominate a single ring within
// hours. The heartbeat ring therefore spans MAX_HEARTBEAT_LOGS × HEARTBEAT_MS
// — a few recent hours, deliberately not a session. It is the /logs page's
// recent view; every heartbeat is also written to `engine_logs`, which is
// where a whole session's heartbeats are read back. The span is stated as
// the product rather than a figure because the figure has been wrong at
// every cadence change.
export const MAX_LOGS = 2000;
export const MAX_HEARTBEAT_LOGS = 500;

export interface LogRings {
  logs: RingLogEntry[];
  heartbeatLogs: RingLogEntry[];
}

// On `globalThis` for the reason `engine-singleton`'s state is: the
// instrumentation hook and the route handlers can load in different module
// graphs, and both must write and read the same rings.
const RINGS_KEY = "__crossfireLogRings__" as const;
type GlobalWithRings = typeof globalThis & { [RINGS_KEY]?: LogRings };

export function logRings(): LogRings {
  const g = globalThis as GlobalWithRings;
  return (g[RINGS_KEY] ??= { logs: [], heartbeatLogs: [] });
}

/**
 * Put one record on the ring its level belongs to.
 *
 * **The engine's log handler and the pipe's ring sink are the same function
 * on purpose.** Heartbeats keep their own ring so a 60s cadence can never
 * evict a trade or an error, and that split is decided by the level — one
 * copy of the rule means a tagged line cannot land in the wrong ring by
 * being routed through a second, slightly different one.
 */
export function pushToRing(entry: RingLogEntry): void {
  const rings = logRings();
  if (entry.level === "heartbeat") {
    rings.heartbeatLogs.push(entry);
    if (rings.heartbeatLogs.length > MAX_HEARTBEAT_LOGS) rings.heartbeatLogs.shift();
  } else {
    rings.logs.push(entry);
    if (rings.logs.length > MAX_LOGS) rings.logs.shift();
  }
  relayLogLine(() => projectLogRecord(entry, newestSeq(entry, rings)));
}

/** Projects only when a browser is listening: every line the process logs
 *  passes here, and a projection nobody reads is work on the logging path. */
function relayLogLine(project: () => WireLogRecord): void {
  const relay = peekBroadcaster();
  if (relay?.hasListeners()) relay.emitLogLine(project());
}

/** The `seq` the logs read would stamp on the entry just pushed: its ring
 *  index, offset past the main ring for a heartbeat as `getLogsByLevel` does. */
function newestSeq(entry: RingLogEntry, rings: LogRings): number {
  return entry.level === "heartbeat"
    ? rings.logs.length + rings.heartbeatLogs.length - 1
    : rings.logs.length - 1;
}

/**
 * Fold a burst repeat onto the ring entry its window opened, so the count
 * the `/logs` poll reads climbs while the window is open instead of sitting
 * at 1 until the next restart hydrates the row back.
 *
 * **The entry is mutated in place, and that is what leaves the ring's
 * append/evict semantics alone.** Nothing is appended, removed or reordered
 * — the array's length and every index are untouched, so the cap and the
 * `shift()` that enforces it behave exactly as they did. Re-appending the
 * updated record instead would evict one extra entry per repeat and move a
 * 30-second-old line to the head of a ring the accessors read as
 * chronological.
 *
 * **Only the main ring is searched**, because `heartbeat` is one of the two
 * burst-exempt categories: the pipe hands a heartbeat line no cause key at
 * all, so no update can ever name one. The heartbeat ring is not read here,
 * not written here, and stays what it was.
 *
 * The walk is backwards from the newest entry and stops at the first entry
 * older than the window's first line, which bounds it to the lines emitted
 * inside a 30-second window. **Finding nothing is a real outcome, not a
 * failure**: a burst whose first line has already been evicted under ring
 * pressure leaves the count to the durable row, which is still bumped.
 */
function bumpRingBurst(update: BurstUpdate): void {
  const ring = logRings().logs;
  for (let i = ring.length - 1; i >= 0; i--) {
    const entry = ring[i];
    if (entry.timestamp < update.timestamp) return;
    if (entry.timestamp === update.timestamp && entry.burstKey === update.burstKey) {
      entry.burstCount = update.count;
      entry.lastSeenAt = update.lastSeenAt;
      relayLogLine(() => projectLogRecord(entry, i));
      return;
    }
  }
}

// Registered at import time, on the store sink's precedent and for the same
// reason: a `log.*` line is emitted — and can fold — before any engine
// exists, and a sink wired at engine construction would miss the whole boot
// window, which is the gap this closes. The pipe stays a leaf; it knows
// nothing about this module.
setLogRingSink({ push: pushToRing, bump: bumpRingBurst });
