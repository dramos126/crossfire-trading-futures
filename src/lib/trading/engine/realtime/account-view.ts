import type { Order, OrderStatus, Position } from "@/lib/brokers/types";

/**
 * The per-account view of open positions and working orders that the
 * dashboard reads instead of asking the broker
 * (docs/proposals/engine-account-view.md).
 *
 * **Display only.** Nothing that acts — entry, exit, flatten, modify, the
 * watchdog's flatten decision — reads it; those keep their live broker reads
 * (engine.md, *Source of truth splits at entry*). The engine's sweeps write
 * what they already read, user-hub frames patch it between sweeps, and a
 * route that finds it missing or stale makes one live read per account and
 * stores that.
 *
 * Parked on `globalThis` for the reason `engine-singleton.ts` parks its
 * state: the route handlers and the engine can load this module in two
 * module graphs inside one process, and two maps would mean the routes never
 * see a sweep's write.
 */

export type AccountViewSource = "sweep" | "hub" | "route";

/** Older than this, a route does one live read before answering. Measured
 *  from the last whole-account read, never from a hub patch — a patch
 *  changes one entity and says nothing about the rest of the slice. */
export const ACCOUNT_VIEW_MAX_AGE_MS = 60_000;

/** After a failed read-through, callers are answered from memory this long.
 *  In a 429 storm every tab polls at 2.5 s with the stream down; retrying on
 *  each poll is the load the view exists to remove (A115). */
export const ACCOUNT_VIEW_FAILURE_HOLD_MS = 30_000;

export interface AccountViewSlice<T> {
  items: readonly T[];
  /** The instant the slice is known to describe, epoch ms: a whole read's ask
   *  time or a hub frame's arrival. What the response's `asOf` says. */
  asOf: number;
  source: AccountViewSource;
  /** Ask time of the last whole-account read, epoch ms. What the 60 s rule
   *  measures. */
  readAt: number;
}

type ViewKind = "positions" | "orders";

interface AccountEntry {
  positions?: AccountViewSlice<Position>;
  orders?: AccountViewSlice<Order>;
}

interface ViewState {
  accounts: Map<number, AccountEntry>;
  inflight: Map<string, Promise<AccountViewSlice<Position> | AccountViewSlice<Order>>>;
  failed: Map<string, { at: number; error: unknown }>;
}

const GLOBAL_KEY = "__crossfireAccountView__" as const;
type GlobalWithView = typeof globalThis & { [GLOBAL_KEY]?: ViewState };

function state(): ViewState {
  const g = globalThis as GlobalWithView;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { accounts: new Map(), inflight: new Map(), failed: new Map() };
  // A view parked by a build from before `failed` existed (dev hot reload).
  g[GLOBAL_KEY].failed ??= new Map();
  return g[GLOBAL_KEY];
}

function entry(accountId: number): AccountEntry {
  const s = state();
  let e = s.accounts.get(accountId);
  if (!e) {
    e = {};
    s.accounts.set(accountId, e);
  }
  return e;
}

/**
 * A whole read replaces the slice unless the slice already describes a later
 * instant. `askedAt` is when the caller sent the request, taken before the
 * fetch: a read asked before a size-0 hub frame but landing after it would
 * otherwise resurrect the closed position, and a slow route read could
 * overwrite a newer sweep's. Returns the slice that stands.
 */
function replaceUnlessNewer<T>(
  prev: AccountViewSlice<T> | undefined,
  items: readonly T[],
  source: Exclude<AccountViewSource, "hub">,
  askedAt: number,
): AccountViewSlice<T> {
  if (prev && (prev.readAt > askedAt || prev.asOf > askedAt)) return prev;
  return { items: items.slice(), asOf: askedAt, source, readAt: askedAt };
}

/** A sweep's or a route's whole-account positions read, stamped with its ask time. */
export function recordPositions(
  accountId: number,
  positions: readonly Position[],
  source: Exclude<AccountViewSource, "hub">,
  askedAt: number = Date.now(),
): AccountViewSlice<Position> {
  const e = entry(accountId);
  e.positions = replaceUnlessNewer(e.positions, positions, source, askedAt);
  return e.positions;
}

/** A sweep's or a route's whole-account working-orders read, stamped with its ask time. */
export function recordOrders(
  accountId: number,
  orders: readonly Order[],
  source: Exclude<AccountViewSource, "hub">,
  askedAt: number = Date.now(),
): AccountViewSlice<Order> {
  const e = entry(accountId);
  e.orders = replaceUnlessNewer(e.orders, orders, source, askedAt);
  return e.orders;
}

/**
 * A user-hub position frame. A frame is one contract's current state, so it
 * replaces that contract's row (size 0 removes it). With no slice yet there
 * is nothing to patch: the frame says nothing about the account's other
 * contracts, and the next read builds the slice whole.
 */
export function applyPositionEvent(accountId: number, position: Position, now: number = Date.now()): void {
  const e = state().accounts.get(accountId);
  const prev = e?.positions;
  if (!e || !prev) return;
  const rest = prev.items.filter((p) => p.contractId !== position.contractId);
  const items = position.size > 0 ? [...rest, position] : rest;
  e.positions = { items, asOf: now, source: "hub", readAt: prev.readAt };
}

/** Working only: 1 is kept and every other shared code dropped, 5 (pending)
 *  included. */
const WORKING_ORDER_STATUS: OrderStatus = 1;

/** A user-hub order frame: a Working order is upserted by id, any other status
 *  removes it. Same no-slice rule as positions. */
export function applyOrderEvent(accountId: number, order: Order, now: number = Date.now()): void {
  const e = state().accounts.get(accountId);
  const prev = e?.orders;
  if (!e || !prev) return;
  const rest = prev.items.filter((o) => o.id !== order.id);
  const items = order.status === WORKING_ORDER_STATUS ? [...rest, order] : rest;
  e.orders = { items, asOf: now, source: "hub", readAt: prev.readAt };
}

function isFresh<S extends { readAt: number }>(slice: S | undefined, now: number): slice is S {
  return slice != null && now - slice.readAt < ACCOUNT_VIEW_MAX_AGE_MS;
}

/** The positions slice if its last whole read is under 60 s old, else null. */
export function freshPositions(accountId: number, now: number = Date.now()): AccountViewSlice<Position> | null {
  const slice = state().accounts.get(accountId)?.positions;
  return isFresh(slice, now) ? slice : null;
}

/** The orders slice if its last whole read is under 60 s old, else null. */
export function freshOrders(accountId: number, now: number = Date.now()): AccountViewSlice<Order> | null {
  const slice = state().accounts.get(accountId)?.orders;
  return isFresh(slice, now) ? slice : null;
}

function readThrough<T>(
  kind: ViewKind,
  accountId: number,
  current: AccountViewSlice<T> | undefined,
  fetch: () => Promise<readonly T[]>,
  record: (items: readonly T[], askedAt: number) => AccountViewSlice<T>,
): Promise<AccountViewSlice<T>> {
  const now = Date.now();
  if (isFresh(current, now)) return Promise.resolve(current);
  const s = state();
  const key = `${kind}:${accountId}`;
  const pending = s.inflight.get(key) as Promise<AccountViewSlice<T>> | undefined;
  if (pending) return pending;
  const failure = s.failed.get(key);
  if (failure && now - failure.at < ACCOUNT_VIEW_FAILURE_HOLD_MS) {
    // The stale slice keeps its old `asOf` and `source`, so the response says
    // how old it is rather than passing it off as a fresh read.
    return current ? Promise.resolve(current) : Promise.reject(failure.error);
  }
  // One live read per account however many callers arrive while it is out —
  // three tabs and twenty probes are one broker request, not twenty-three.
  const p = (async () => {
    const askedAt = Date.now();
    try {
      const items = await fetch();
      s.failed.delete(key);
      return record(items, askedAt);
    } catch (error) {
      s.failed.set(key, { at: Date.now(), error });
      throw error;
    }
  })().finally(() => {
    s.inflight.delete(key);
  });
  s.inflight.set(key, p as Promise<AccountViewSlice<Position> | AccountViewSlice<Order>>);
  return p;
}

/** Fresh positions slice, or one shared live read stored as `source`. A
 *  failed read rejects every waiter and stores no slice; for the next 30 s
 *  callers get the stale slice if there is one, else the same error. */
export function readPositionsThrough(
  accountId: number,
  fetch: () => Promise<readonly Position[]>,
  source: Exclude<AccountViewSource, "hub">,
): Promise<AccountViewSlice<Position>> {
  return readThrough("positions", accountId, state().accounts.get(accountId)?.positions, fetch, (items, askedAt) =>
    recordPositions(accountId, items, source, askedAt),
  );
}

/** Fresh orders slice, or one shared live read stored as `source`. Same
 *  failure rule as positions. */
export function readOrdersThrough(
  accountId: number,
  fetch: () => Promise<readonly Order[]>,
  source: Exclude<AccountViewSource, "hub">,
): Promise<AccountViewSlice<Order>> {
  return readThrough("orders", accountId, state().accounts.get(accountId)?.orders, fetch, (items, askedAt) =>
    recordOrders(accountId, items, source, askedAt),
  );
}

/** Tests only: the view is process state and outlives a test. */
export function resetAccountViewForTests(): void {
  const s = state();
  s.accounts.clear();
  s.inflight.clear();
  s.failed.clear();
}
