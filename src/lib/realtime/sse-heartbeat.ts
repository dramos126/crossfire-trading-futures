/**
 * The relay's heartbeat, apart from `sse.ts` because the browser reads it too
 * and that module reaches the database.
 */

export const SSE_HEARTBEAT_MS = 25_000;

/** No bytes for this long — not even a heartbeat — and a reader takes the
 *  stream as dead: a half-open connection never errors. */
export const SSE_IDLE_MS = 2.5 * SSE_HEARTBEAT_MS;
