"use client";

import { useSyncExternalStore } from "react";

/**
 * The browser's copy of the engine's per-leg setup readings — the Dashboard's
 * `ARMED` chip.
 *
 * **Its lifetime is the live stream's.** The engine says only *that* the map
 * changed (`setupsChanged`, payload-free), so the copy is current exactly while
 * the stream that carries those frames is open: it is read when the stream
 * opens and on every frame, and dropped back to unread when the stream ends.
 * Unread renders as plain `Flat`, which claims nothing.
 *
 * The read goes through `POST /api/engine {action:"status"}`, the route that
 * owns the map's shape. Overlapping reads resolve newest-asked-wins, so a slow
 * answer to an earlier frame cannot overwrite a later one.
 */

type Readings = ReadonlyMap<string, string>;

let snapshot: Readings | null = null;
let asked = 0;
const listeners = new Set<() => void>();

function publish(next: Readings | null): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** The status body's `setups` field, narrowed. Null when it is not a map of strings. */
export function parseSetupReadings(value: unknown): Map<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out = new Map<string, string>();
  for (const [id, note] of Object.entries(value)) {
    if (typeof note === "string" && note.trim().length > 0) out.set(id, note);
  }
  return out;
}

/** Re-read the map. A failed or malformed read leaves it unread, never stale. */
export async function refreshSetupReadings(): Promise<void> {
  const ask = ++asked;
  let next: Readings | null = null;
  try {
    const res = await fetch("/api/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    if (res.ok) {
      const body: unknown = await res.json();
      next =
        typeof body === "object" && body !== null
          ? parseSetupReadings((body as { setups?: unknown }).setups)
          : null;
    }
  } catch {
    next = null;
  }
  if (ask === asked) publish(next);
}

/** The stream ended: nothing can say the copy is current any more. */
export function clearSetupReadings(): void {
  asked++;
  if (snapshot !== null) publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Deployment id → setup note, or `null` while unread. */
export function useSetupReadings(): Readings | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}
