"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * The browser's one copy of `POST /api/engine {action:"status"}` — running,
 * market hub, seam health, setups — for every surface that shows it: the
 * status pill and rail (`useSystemHealth`) and the `/logs` engine card.
 *
 * **Pushed, not polled.** The engine sends the whole status as an
 * `engineStatus` frame whenever it changes, so while the stream is up nothing
 * re-reads it on a timer. It is read once when a session starts, again each
 * time the stream comes back (the frames sent while it was down are gone), and
 * on `ENGINE_STATUS_FALLBACK_MS` only while the stream is down — the one poll
 * that survives, because a stream that is down carries nothing.
 *
 * Kept as the route's body, unparsed: each consumer narrows the fields it
 * reads, at the boundary, as it always has. Overlapping reads resolve
 * newest-wins, and a frame counts as the newest, so a slow read issued before
 * a push cannot overwrite it.
 */

export type EngineStatusBody = Readonly<Record<string, unknown>>;

/** The fallback read's cadence while the stream is down — the cadence every
 *  status surface polled at before the stream carried the status. */
export const ENGINE_STATUS_FALLBACK_MS = 5_000;

let snapshot: EngineStatusBody | null = null;
let asked = 0;
const listeners = new Set<() => void>();

function publish(next: EngineStatusBody | null): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function asBody(value: unknown): EngineStatusBody | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as EngineStatusBody)
    : null;
}

/** An `engineStatus` frame's status. Anything that is not an object is
 *  dropped and the held copy stays. */
export function applyEngineStatus(status: unknown): void {
  const body = asBody(status);
  if (!body) return;
  asked++;
  publish(body);
}

/** Read the status route once. A failed read keeps the held copy. */
export async function refreshEngineStatus(): Promise<void> {
  const ask = ++asked;
  try {
    const res = await fetch("/api/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    if (!res.ok) return;
    const body = asBody(await res.json());
    if (body && ask === asked) publish(body);
  } catch {
    // Keeps the held copy; the next read or frame replaces it.
  }
}

/** The session ended: nothing held describes the next one. */
export function clearEngineStatus(): void {
  asked++;
  if (snapshot !== null) publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last status read or pushed, or `null` before the first. */
export function useEngineStatus(): EngineStatusBody | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}

/**
 * Keeps the copy current: mounted once, by the trading provider, which holds
 * the session and the stream's state. `live` going true is the stream coming
 * back, so it reads; going false starts the fallback.
 */
export function useEngineStatusFeed(token: string | null, live: boolean): void {
  useEffect(() => {
    if (!token) {
      clearEngineStatus();
      return;
    }
    void refreshEngineStatus();
    if (live) return;
    const id = setInterval(() => void refreshEngineStatus(), ENGINE_STATUS_FALLBACK_MS);
    return () => clearInterval(id);
  }, [token, live]);
}
