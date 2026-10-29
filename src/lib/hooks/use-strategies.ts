"use client";

import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import { TradingContext } from "@/lib/hooks/use-trading/use-trading-state";
import type { Deployment } from "@/lib/trading/domain";
import { isClosingStatus } from "@/lib/trading/domain";

/** Deployments held back by the practice-only filter. The engine still
 *  starts; these rows just don't run until practice-only is toggled off. */
export interface SkippedNonPrac {
  id: string;
  accountId: number;
  accountName: string | null;
}

/** Deployments the live-account block withheld from the engine. The row
 *  still reads `Active` in the UI and the engine will never trade it, so
 *  a caller that drops this field leaves the operator with no surface for
 *  it at all — the only other trace is a `log.warn`. `reason` is the
 *  refusal verbatim, and distinct reasons must not be merged: an
 *  unclassified account is recoverable where a live one is not. */
export interface SkippedLiveAccount {
  id: string;
  accountId: number;
  reason: string;
}

/**
 * Push the current deployment list to the engine. `action` should be
 * "update" for toggle/edit/delete and "start" for new deployments.
 * Caller passes token + practiceOnly so this file doesn't depend on the
 * Topstep context.
 */
export async function syncEngine(
  action: "start" | "update" | "stop",
  opts: { token: string | null; practiceOnly: boolean; deployments: Deployment[] },
): Promise<{
  ok: boolean;
  error?: string;
  skippedNonPrac?: SkippedNonPrac[];
  skippedLiveAccounts?: SkippedLiveAccount[];
}> {
  if (!opts.token) return { ok: false, error: "Not authenticated" };
  try {
    const res = await fetch("/api/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        deployments: opts.deployments,
        practiceOnly: opts.practiceOnly,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error ?? res.statusText };
    }
    const data = (await res.json().catch(() => ({}))) as {
      skippedNonPrac?: SkippedNonPrac[];
      skippedLiveAccounts?: SkippedLiveAccount[];
    };
    return {
      ok: true,
      skippedNonPrac: data.skippedNonPrac,
      skippedLiveAccounts: data.skippedLiveAccounts,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Engine sync failed" };
  }
}

// ── Deployment store ────────────────────────────────────────────────
//
// Deployments live in SQLite on the server, reached via /api/deployments.
// This module caches the list in memory and fans out updates to every
// React component via useSyncExternalStore. Every mutation writes through
// to the server, then refreshes the cache from the server response so the
// UI and DB never drift.

let cachedSnapshot: Deployment[] = [];
let listeners: Array<() => void> = [];
let hasHydrated = false;
let hydrationPromise: Promise<void> | null = null;

/**
 * Whether the list on screen is one the server actually answered with.
 *
 * **An empty `deployments` is three different facts and the array cannot
 * tell them apart** — nothing is deployed, the first read has not landed,
 * or the read failed. On a board whose entire job is saying what is
 * running, rendering the third as *"nothing is deployed"* is the lie the
 * *Dashboard auth-failure state* punchlist entry exists about: the operator
 * concludes nothing needs attention. So the store carries the fact, because
 * it is the only thing that knows it — `buildBoard` is a pure function over
 * the list and a component cannot recover it from `[]`.
 *
 * `failed` is sticky until the next read succeeds. Nothing polls behind this
 * store, so a failed hydration is not corrected a few seconds later; it is
 * corrected by the next mutation, the next `deploymentsChanged` frame, a new
 * session token, or a reload.
 */
export type DeploymentsLoadState = "idle" | "loading" | "ready" | "failed";
let loadState: DeploymentsLoadState = "idle";

function setLoadState(next: DeploymentsLoadState): void {
  if (loadState === next) return;
  loadState = next;
  listeners.forEach((l) => l());
}
/** Bumped by every write. A read that started before a write landed is
 *  older than the store and must not be applied over it. */
let snapshotGeneration = 0;
let refreshInFlight: Promise<void> | null = null;
let refreshPending = false;
const SERVER: Deployment[] = [];

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => { listeners = listeners.filter((l) => l !== listener); };
}

function getSnapshot(): Deployment[] {
  return cachedSnapshot;
}

function getServerSnapshot(): Deployment[] {
  return SERVER;
}

function setSnapshot(next: Deployment[]): void {
  snapshotGeneration += 1;
  cachedSnapshot = next;
  listeners.forEach((l) => l());
}

/** Snapshot of the current in-memory cache. Components that need a
 *  post-write read (e.g. to pass to syncEngine) can use this instead of
 *  waiting for the next React render. */
export function loadDeployments(): Deployment[] {
  return cachedSnapshot;
}

/**
 * Force a refresh from the server. Group ops bypass the per-call
 * addDeployment/updateDeployment hooks (they hit /api/groups), so the
 * cache otherwise wouldn't pick up the new legs until a hard reload. Also
 * the whole client half of `deploymentsChanged`, which is what makes the
 * three properties below load-bearing rather than tidy.
 *
 * **Coalesced, because one operator action is many events.** A group pause
 * of N legs settles N times and each settle emits, so a naive call per
 * frame is N full `includeTrash` list reads per connected tab. Same problem
 * `use-trades.ts` solved for `/api/trades`; the guard is the same one.
 *
 * **Trailing-edge, unlike that sibling, and the difference is the bug.** A
 * frame arriving while a read is in flight may describe a write that read
 * was issued *before* — so it schedules exactly one more read rather than
 * riding the in-flight one. Collapsing it instead is how a leg ends up
 * reading `Pausing` for the rest of the tab's life: the settle to `Paused`
 * lands seconds after the `Pausing` write, and this store hydrates once
 * with no poll behind it, so nothing comes along later to correct it. A
 * burst costs the in-flight read plus one trailing read, and one more per
 * read-latency window while frames keep arriving — the loop is deliberate,
 * not overshoot: it is what stops a slow burst being truncated at two.
 *
 * **A read that lost a race is discarded, not applied.** `setSnapshot` has
 * other callers — hydration and every mutation helper — and a slow SQLite
 * read or a multiplexed connection can land a stale list after a fresh
 * write. The write wins; the mutation behind it emits its own event, so
 * another read is already coming.
 *
 * **Hydration is awaited rather than raced, because the counter measures
 * writes and not freshness.** At mount the two are concurrent, hydration's
 * GET is issued strictly earlier, and `better-sqlite3` serialises the
 * reads — so hydration lands first, bumps the generation, and the discard
 * rule throws away the *fresher* list. Inside that window the outcome is
 * exactly the permanent-`Pausing` failure the trailing edge exists to
 * prevent, entered through the hydration door.
 */
export async function refreshDeployments(token: string | null): Promise<void> {
  if (!token) return;
  if (refreshInFlight) {
    refreshPending = true;
    return refreshInFlight;
  }
  refreshInFlight = drainRefresh();
  return refreshInFlight;
}

async function drainRefresh(): Promise<void> {
  // Cleared inside the drain rather than off the promise, so it goes null in
  // the same turn the loop decides to exit. A `.finally()` clears it a
  // microtask later, and a caller landing in that window sets `refreshPending`
  // against a drain that has already returned — its frame is then dropped.
  try {
    // Serialised against hydration, never raced with it: hydration's own read
    // is older but lands first, so the generation guard would discard the
    // fresher list. Awaiting costs one extra read at mount at worst, and a
    // hydration that failed must not take this frame's read down with it.
    if (hydrationPromise) await hydrationPromise.catch(() => {});
    for (;;) {
      refreshPending = false;
      const generation = snapshotGeneration;
      let next: Deployment[];
      try {
        next = await fetchDeployments();
      } catch (err) {
        // A refetch that 401'd or dropped leaves a list on screen that is no
        // longer one the server has vouched for. Say so rather than letting
        // it read as current — and rethrow, because the SSE consumer and the
        // mutation helpers both already handle the rejection and neither
        // should silently believe the refresh landed.
        setLoadState("failed");
        throw err;
      }
      if (snapshotGeneration === generation) setSnapshot(next);
      setLoadState("ready");
      if (!refreshPending) return;
    }
  } finally {
    refreshInFlight = null;
  }
}

/** A list read the server answered with an error. Carries the status because
 *  a 401 — the session is dead — needs a different answer from a 500 or a
 *  dropped connection, and a message-only `Error` hid which it was. */
export class DeploymentsReadError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`Failed to load deployments: ${statusText || status}`);
    this.name = "DeploymentsReadError";
  }
}

async function fetchDeployments(): Promise<Deployment[]> {
  // includeTrash=true so the in-memory cache covers both Active and
  // Trash tabs on the deployments page without a second roundtrip.
  // Consumers that only want active rows filter on `deletedAt == null`.
  const res = await fetch("/api/deployments?includeTrash=true");
  if (!res.ok) throw new DeploymentsReadError(res.status, res.statusText);
  const data = (await res.json()) as { deployments: Deployment[] };
  return data.deployments;
}

async function hydrate(): Promise<void> {
  if (hasHydrated) return;
  if (hydrationPromise) return hydrationPromise;
  setLoadState("loading");
  hydrationPromise = (async () => {
    try {
      // The stream can be up before this resolves, so hydration is subject to
      // the same ordering rule as a refresh: a newer write already in the
      // store is not overwritten by the list this read started fetching first.
      const generation = snapshotGeneration;
      const next = await fetchDeployments();
      if (snapshotGeneration === generation) setSnapshot(next);
      hasHydrated = true;
      setLoadState("ready");
    } catch (err) {
      // The load state is the whole point of catching here: the mount effect
      // calls this without a handler, so the throw was an unhandled rejection
      // and the store went on reading `[]` — indistinguishable from an
      // install with nothing deployed.
      setLoadState("failed");
      throw err;
    } finally {
      hydrationPromise = null;
    }
  })();
  return hydrationPromise;
}

/**
 * Whether the deployment list is one the server answered with. Subscribes to
 * the same listener set as the snapshot, so a state change re-renders on the
 * frame the snapshot would.
 *
 * Read it alongside `useDeployments()` on any surface where an empty list is
 * a *claim* — see {@link DeploymentsLoadState}.
 */
export function useDeploymentsLoadState(): DeploymentsLoadState {
  return useSyncExternalStore(
    subscribe,
    () => loadState,
    () => "idle" as const,
  );
}

export function useDeployments() {
  const ctx = useContext(TradingContext);
  const token = ctx?.token ?? null;
  const deployments = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!token) return;
    // Swallowed rather than unhandled: `hydrate` records the failure on the
    // load state before it rethrows, so the one consumer that has to know is
    // told, and a rejected promise nobody awaits is not a second channel.
    // A new token over a failed list is the provider's re-mint after a refused
    // session: the list the old token could not read is re-read now, rather
    // than waiting for a frame that may not come.
    const read = hasHydrated && loadState === "failed" ? refreshDeployments(token) : hydrate();
    void read.catch(() => {});
  }, [token]);

  /** What `POST /api/deployments` accepts — **no `groupId`**. The route
   *  creates a parent and its single leg in one transaction and does not
   *  read the field, so accepting it let a caller pass a parent id and
   *  silently mint a second parent instead of attaching a leg. Attaching to
   *  an existing deployment is `add-legs`. */
  const addDeployment = useCallback(
    async (
      input: Omit<
        Deployment,
        | "id"
        | "createdAt"
        | "updatedAt"
        | "orphanedAt"
        | "orphanReason"
        | "deletedAt"
        | "tombstonedAt"
        | "version"
        | "pendingReconciliation"
        | "groupId"
        | "enabledSnapshot"
      >,
    ): Promise<Deployment> => {
      if (!token) throw new Error("Not authenticated");
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Request failed: ${res.status}`);
      }
      const data = (await res.json()) as { deployment: Deployment };
      setSnapshot([...cachedSnapshot, data.deployment]);
      return data.deployment;
    },
    [token],
  );

  /** What `PATCH /api/deployments/[id]` accepts. **Params and ticker are
   *  not on it** — they live on the parent and are pinned at creation
   *  respectively, and the route 400s a body naming either. */
  const updateDeployment = useCallback(
    async (
      id: string,
      patch: Partial<Pick<Deployment, "status" | "accountId" | "name">>,
    ): Promise<Deployment> => {
      if (!token) throw new Error("Not authenticated");
      const res = await fetch(`/api/deployments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Request failed: ${res.status}`);
      }
      const data = (await res.json()) as { deployment: Deployment };
      setSnapshot(cachedSnapshot.map((d) => (d.id === id ? data.deployment : d)));
      return data.deployment;
    },
    [token],
  );

  const toggleDeployment = useCallback(
    async (id: string): Promise<Deployment | null> => {
      const current = cachedSnapshot.find((d) => d.id === id);
      if (!current) return null;
      // Two-valued on purpose: the toggle is the operator's Active/Paused
      // switch, and a row mid-close is not theirs to flip. The affordance is
      // disabled while `Pausing` / `Destroying`; this is the belt.
      if (isClosingStatus(current.status)) return current;
      return updateDeployment(id, {
        status: current.status === "Active" ? "Paused" : "Active",
      });
    },
    [updateDeployment],
  );

  /** Soft-delete by default — server moves the row to trash. Pass
   *  `{ hard: true }` to retire the row (tombstone — the trash tab's
   *  "Retire" button). On soft-delete we update the cached row to
   *  reflect deletedAt + `Paused` instead of stripping it, so
   *  the Trash tab can render it without a server refetch. A delete that
   *  found an open position answers `destroying: true` and the row is not
   *  in Trash yet — refetch rather than guess, so the card can show
   *  Deleting. On retire,
   *  the row stays in the DB with `tombstoned_at` set but is excluded
   *  from both Active and Trash listings, so we filter it out of the
   *  in-memory cache to match. */
  const deleteDeployment = useCallback(
    async (id: string, opts: { hard?: boolean } = {}): Promise<boolean> => {
      if (!token) return false;
      const url = opts.hard ? `/api/deployments/${id}?hard=true` : `/api/deployments/${id}`;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => ({}))) as { destroying?: boolean };
      if (opts.hard) {
        setSnapshot(cachedSnapshot.filter((d) => d.id !== id));
      } else if (body.destroying) {
        setSnapshot(
          cachedSnapshot.map((d) =>
            d.id === id ? { ...d, status: "Destroying" as const } : d,
          ),
        );
      } else {
        const now = new Date().toISOString();
        setSnapshot(
          cachedSnapshot.map((d) =>
            d.id === id
              ? { ...d, deletedAt: now, status: "Paused" as const, updatedAt: now }
              : d,
          ),
        );
      }
      return true;
    },
    [token],
  );

  return { deployments, addDeployment, updateDeployment, toggleDeployment, deleteDeployment };
}
