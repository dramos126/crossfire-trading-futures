/**
 * Burst collapse. Identical-cause lines inside a window become one row
 * with a count, so the boot that emitted ~23 `fill … not in
 * tradovate_order_map — dropping` warnings in a single frame renders one
 * line saying 23 instead of burying the boot summary under them.
 *
 * Pure bookkeeping over keys and windows — it knows nothing about
 * records, the store or the console. `pipe.ts` asks it a question and
 * decides what to do with the answer.
 *
 * Owned by docs/modules/logging/README.md.
 */

/** How long identical causes fold together. */
const BURST_WINDOW_MS = 30_000;

/**
 * Bound on live windows. A 24/7 process cannot hold a map keyed on
 * anything a log line can vary; the sweep runs on insert rather than on a
 * timer, so this module owns no handle anyone has to remember to clear.
 */
const BURST_MAX_KEYS = 512;

/**
 * Digit runs of this length or more are collapsed before hashing — **only
 * for a line whose call site handed the pipe a `burstKey`**. That opt-in
 * is the site declaring "my repeats differ only in ids"; the burst this
 * exists for carries both an account id and an order id, so hashing its
 * raw text yields 23 distinct keys and collapses nothing.
 *
 * Applied unconditionally it erased discriminators call sites deliberately
 * carry — a per-account re-routing line, an N-account flatten failure, a
 * stranded trade id — and a folded repeat reaches no surface at all. Four
 * digits because an HTTP status is exactly three, the same threshold the
 * engine's exit-dispatch anchor normalises on and for the same reason.
 */
const VOLATILE_DIGIT_RUN = /\d{4,}/g;

interface BurstWindow {
  firstTimestamp: string;
  firstAt: number;
  count: number;
}

const windows = new Map<string, BurstWindow>();

/**
 * FNV-1a. Cheap, stable, and only ever compared against itself.
 *
 * Hashed rather than carried verbatim because the resolved key is written
 * to `engine_logs.burst_key` on every row, and a raw message there would
 * be a second copy of the message column on every line the engine emits.
 */
function hashMessage(message: string, collapseDigits: boolean): string {
  const normalised = collapseDigits ? message.replace(VOLATILE_DIGIT_RUN, "#") : message;
  let h = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i++) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The cause key: the message, the event when the line has one, the
 * deployment, and whatever finer cause the call site named.
 *
 * **The message is always in the key, and the event is an extra axis on top
 * of it — never a replacement for it.** An event names a *kind* of thing
 * that happened, not an instance: two `bracket_cancel_failed` lines naming
 * two order ids, two `hub_reconnect_failed` lines naming attempts #1 and
 * #2, two `manual_position_lookup_failed` lines naming two accounts. All of
 * those are one event and several incidents, and keying on the event alone
 * folded every one of them into the first — which is the erasure the
 * composition contract forbids, arriving from the other side of the key
 * from the digit collapse. Adding the message can only ever *narrow* what
 * folds, so nothing that used to be written stops being written.
 *
 * **Normalisation is opt-in.** A bare line keys on the *exact* scrubbed
 * message, so two ids are two incidents and both are written. Only a line
 * carrying a `burstKey` — the call site declaring that its repeats differ
 * in ids alone — has its digit runs collapsed. The pipe must never erase a
 * discriminator a call-site anchor deliberately carries; see the
 * composition rule in docs/modules/logging/README.md.
 */
export function burstKeyFor(
  event: string | null,
  deploymentId: string,
  burstKey: string | null,
  message: string,
): string {
  const cause = hashMessage(message, burstKey !== null);
  return `${event ?? ""}|${cause}|${deploymentId}|${burstKey ?? ""}`;
}

export type BurstOutcome =
  /** Nothing to collapse onto — this line opens a window and is written. */
  | { first: true }
  /** Folded into an open window. The caller updates the row it names. */
  | { first: false; firstTimestamp: string; count: number };

/** `nowMs` is the caller's instant, never `Date.now()` — one clock per
 *  call, so a sweep cannot disagree with the insert that triggered it. */
function evictOldest(nowMs: number): void {
  const cutoff = nowMs - BURST_WINDOW_MS;
  for (const [key, w] of windows) {
    if (w.firstAt < cutoff) windows.delete(key);
  }
  // Map iteration is insertion-order, so the first key left is the oldest.
  while (windows.size > BURST_MAX_KEYS) {
    const oldest = windows.keys().next();
    if (oldest.done) break;
    windows.delete(oldest.value);
  }
}

/**
 * First emission inserts; repeats inside the window increment. The count
 * lands as one `burst_count` / `last_seen_at` update on the store's
 * existing flush cadence — never a write per repeat, which would be the
 * burst again with extra steps.
 */
export function observeBurst(key: string, timestamp: string, nowMs: number): BurstOutcome {
  const open = windows.get(key);
  if (open && nowMs - open.firstAt < BURST_WINDOW_MS) {
    open.count += 1;
    return { first: false, firstTimestamp: open.firstTimestamp, count: open.count };
  }
  if (windows.size >= BURST_MAX_KEYS) evictOldest(nowMs);
  windows.set(key, { firstTimestamp: timestamp, firstAt: nowMs, count: 1 });
  return { first: true };
}

/** Drop every open window. Paired with a log wipe, and a test seam. */
export function resetBursts(): void {
  windows.clear();
}
