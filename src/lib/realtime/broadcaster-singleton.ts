import { EventBroadcaster, type BroadcasterDeps } from "./event-broadcaster";

/**
 * Process-wide singleton for the broadcaster. Stashed on `globalThis` so
 * it survives Next.js bundle splits — in Turbopack dev the engine route
 * and the SSE route load this module in separate bundles, each with its
 * own module-scoped `let`. Without globalThis the engine's broadcaster
 * never sees the SSE listeners and `marketTrade` fan-out is silently lost.
 *
 * The caller supplies the deps (`engine.broadcasterDeps()`), which are
 * null until the engine has been constructed with a realtime transport —
 * typically by calling `getEngine()` from the engine route before
 * reaching the SSE handler. Until then this returns null so callers can
 * fall back to REST polling.
 */

// Historical name, kept deliberately. It is a live `globalThis` key, not a
// module path: renaming it mid-session in dev would leave two module graphs
// holding two broadcasters under two keys, and the SSE listeners on one of
// them would stop seeing engine events. The broadcaster is not Topstep's;
// this string is just its address.
const GLOBAL_KEY = "__topstepBroadcaster__";
type Holder = { broadcaster: EventBroadcaster | null };

function holder(): Holder {
  const g = globalThis as unknown as Record<string, Holder>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { broadcaster: null };
  return g[GLOBAL_KEY];
}

export function getBroadcaster(deps: BroadcasterDeps | null): EventBroadcaster | null {
  if (!deps) return null;
  const h = holder();
  if (!h.broadcaster) {
    h.broadcaster = new EventBroadcaster(deps);
  }
  return h.broadcaster;
}

/** Read-only access to the existing broadcaster, if one has been built.
 *  Engine code uses this to emit synthetic events (like strategyTrade)
 *  without re-running the construction path or asserting realtime-bars
 *  is on. Returns null silently when no broadcaster exists yet. */
export function peekBroadcaster(): EventBroadcaster | null {
  return holder().broadcaster;
}

/** Test-seam / shutdown path — drops the singleton reference. The
 *  underlying transports are not torn down (shared with the engine). */
export function resetBroadcaster(): void {
  holder().broadcaster = null;
}
