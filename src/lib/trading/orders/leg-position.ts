import type { OpenPosition } from "../strategy-types";
import type { Deployment, DeploymentGroup } from "@/lib/trading/domain";

/**
 * Shape required from the engine's per-deployment state. Defined
 * structurally so callers don't have to import the engine's private
 * `DeploymentState` interface — the only field this primitive cares
 * about is `position`.
 */
export interface LegPositionStateView {
  position: OpenPosition | null;
}

/**
 * A leg is "engine-enabled" when it is `Active` and its parent is enabled
 * and not soft-deleted. Every leg has a parent, so a missing one is a
 * broken row rather than a standalone — and it answers false, which is the
 * conservative direction.
 *
 * Use this at engine **entry-eval** sites where we want "the trader's
 * current intent for this leg." Exit-eval does not call it: a leg the
 * parent turned off is a leg the engine still owes a flatten, so exit-eval
 * gates on status alone (`isEngineManagedStatus`). That replaced the
 * `d.enabled || legHasOpenPosition(state)` widening — see
 * [deployments.md](../../../docs/modules/trading/deployments.md).
 */
export function legAndGroupEnabled(
  leg: Deployment,
  group: DeploymentGroup | null,
): boolean {
  if (leg.status !== "Active") return false;
  if (group == null) return false;
  if (group.deletedAt != null) return false;
  return group.enabled;
}

/**
 * True when a deployment leg currently holds a broker-tracked position
 * the engine is managing.
 *
 * **Not an exit-loop predicate any more.** Exit-eval scope is now the
 * deployment's status (`isEngineManagedStatus`), because a pause that
 * leaves a position open is a `Pausing` row rather than a disabled row
 * with a position hanging off it. What survives is the route-level
 * destructive-op gate and the "should this close now" question the
 * closing guard asks.
 *
 * In-memory engine state is the source of truth here: by the time the
 * engine boots, `start()` rehydrates `state.position` from the DB for
 * every still-open trade (`rebuildStatePositionsFromDb`), so a leg with
 * a position will always have a populated `state` entry.
 *
 * Hot-path callers (per-tick exit eval) pass only `state` and stay
 * synchronous. Route-level destructive-op gates (group session edit,
 * group soft-delete) pass the async {@link legHasOpenPositionWithFallback}
 * variant so a cold-boot or post-auth-failure engine can still consult
 * the broker before letting a destructive op through.
 */
export function legHasOpenPosition(
  state: LegPositionStateView | undefined,
): boolean {
  return state?.position != null;
}

/**
 * Async variant for HTTP routes guarding destructive ops: prefers
 * engine in-memory state when present, falls back to a broker-side
 * position query (`brokerCheck`) when the engine isn't ready or has no
 * state for the leg. Mirrors the source-priority used by
 * `runPendingSessionMigrations` and the same fail-closed-on-broker-error
 * policy — a broker query that throws is treated as "in position to be
 * safe" so we never silently let a destructive op through on a cold
 * boot.
 *
 * Pass `undefined` for `state` when the engine isn't ready
 * (`getEngineIfReady() === null`) or hasn't yet rehydrated the leg —
 * `peekState()` returns `undefined` for unknown ids, which matches the
 * signature here and routes the call through `brokerCheck`.
 */
export async function legHasOpenPositionWithFallback(
  state: LegPositionStateView | undefined,
  brokerCheck: () => Promise<boolean>,
): Promise<boolean> {
  if (state) return state.position != null;
  try {
    return await brokerCheck();
  } catch {
    return true;
  }
}
