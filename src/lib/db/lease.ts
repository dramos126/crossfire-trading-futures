// The engine lease: one row that says which process runs the engine on this
// database and when it last said so. Every engine entry point refuses without
// it (docs/modules/trading/engine-boot.md, *Hard rules*).
//
// One container used to guarantee one engine by being the only process. The
// web/engine split and the hand-over put a second process on the same file,
// so the guarantee has to be a thing the code holds. A row in `trading.db`
// rather than a file lock — `flock` on a Docker bind mount is unreliable — or
// a service a public user would have to install (zero-downtime-deploys.md,
// decision 4).
//
// The instants are epoch-ms integers, as `engine_restart`'s are, and for the
// same reason: whether a lease is stale decides whether a second engine may
// start, and that decision does not go through an ISO-string parse.

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { log } from "@/lib/logger";
import { getDb, registerMigration } from "./connection";

registerMigration((d) => {
  // `handoff_requested_by` names a standby process asking the holder to
  // yield (engine-boot.md, *Hand-off*).
  d.exec(`
    CREATE TABLE IF NOT EXISTS engine_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      holder TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      acquired_at INTEGER,
      renewed_at INTEGER,
      handoff_requested_by TEXT
    );
    INSERT OR IGNORE INTO engine_lease (id) VALUES (1);
  `);
});

// When the standby last said it is still asking. Its own block, and added:
// the running engine reads this table through the previous build while a
// standby migrates it (persistence README, *Hard rules*).
registerMigration((d) => {
  const columns = d.prepare(`PRAGMA table_info(engine_lease)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "handoff_requested_at")) return;
  d.exec(`ALTER TABLE engine_lease ADD COLUMN handoff_requested_at INTEGER`);
});

/**
 * How often the holder re-stamps `renewed_at`, and how old a stamp may get
 * before another process may take the lease.
 *
 * **Not the liveness constants, and deliberately faster.** The 60s liveness
 * stamp measures how long a position went unmanaged against a ten-minute
 * threshold, so a minute of slack costs nothing. This window is how long the
 * next engine waits after a crash: Docker restarts a crashed container in
 * seconds, and a lease that stayed fresh for minutes would hold every crash
 * restart blind for that long. Fresh is four renew periods, so a slow disk or
 * a busy database that fails one or two renews does not hand the lease away;
 * a planned stop releases it as the process exits and the next process takes
 * it at once.
 */
export const LEASE_RENEW_MS = 5_000;
export const LEASE_FRESH_MS = 20_000;

/**
 * How recently a standby must have refreshed its hand-off request for the
 * holder to accept it, and for a second standby to find it still standing.
 * The standby refreshes every second, so a live one is never older than
 * this; a standby killed mid-wait leaves a request that is yielded to only
 * inside this window. Narrower than `LEASE_FRESH_MS` on purpose: a yield to a
 * dead standby leaves no engine until the deploy's rollback restarts the old
 * one (infra/README, *Hand-off deploys*).
 */
export const HANDOFF_REQUEST_FRESH_MS = 5_000;

export interface EngineLease {
  holder: string | null;
  generation: number;
  acquiredAt: number | null;
  renewedAt: number | null;
  handoffRequestedBy: string | null;
  handoffRequestedAt: number | null;
}

export interface LeaseAttempt {
  acquired: boolean;
  /** Who holds it after the attempt — this process when acquired. */
  holder: string | null;
  generation: number;
  renewedAt: number | null;
}

interface LeaseRow {
  holder: unknown;
  generation: unknown;
  acquired_at: unknown;
  renewed_at: unknown;
  handoff_requested_by: unknown;
  handoff_requested_at: unknown;
}

const HOLDER_GLOBAL_KEY = "__crossfireEngineLeaseHolder";
type GlobalWithHolder = typeof globalThis & { [HOLDER_GLOBAL_KEY]?: string };
const HOLDER_RANDOM_BYTES = 4;

/**
 * This process's holder id, `${hostname}:${pid}:${random}`, made once. On
 * `globalThis` because `next dev` re-evaluates modules on hot reload, and a
 * process that minted a second id would read its own lease as someone else's.
 * The random part is what tells a crash-restarted container apart from its
 * previous life: same hostname, and often the same pid.
 */
export function leaseHolderId(): string {
  const g = globalThis as GlobalWithHolder;
  g[HOLDER_GLOBAL_KEY] ??= `${hostname()}:${process.pid}:${randomBytes(HOLDER_RANDOM_BYTES).toString("hex")}`;
  return g[HOLDER_GLOBAL_KEY];
}

function epochOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function textOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** The row, every column validated: it is hand-editable on a mounted volume
 *  and what it says decides whether an engine may start. */
export function readLease(): EngineLease {
  const row = getDb()
    .prepare(
      `SELECT holder, generation, acquired_at, renewed_at, handoff_requested_by, handoff_requested_at
         FROM engine_lease WHERE id = 1`,
    )
    .get() as LeaseRow | undefined;
  const generation = row?.generation;
  return {
    holder: textOrNull(row?.holder),
    generation: typeof generation === "number" && Number.isInteger(generation) ? generation : 0,
    acquiredAt: epochOrNull(row?.acquired_at),
    renewedAt: epochOrNull(row?.renewed_at),
    handoffRequestedBy: textOrNull(row?.handoff_requested_by),
    handoffRequestedAt: epochOrNull(row?.handoff_requested_at),
  };
}

/**
 * A held lease another process may take. **A holder with no readable
 * `renewed_at` is not stale**: no writer here leaves that shape, so it is a
 * hand edit, and reading it as stale would start a second engine on the
 * strength of a value nothing can parse. Refusing is loud and the fix is one
 * UPDATE.
 */
function isStale(lease: EngineLease, nowMs: number): boolean {
  return lease.renewedAt != null && nowMs - lease.renewedAt > LEASE_FRESH_MS;
}

/**
 * Take the lease if it is free, stale, or already ours. One `IMMEDIATE`
 * transaction, so two processes racing for it serialise on the write lock
 * rather than both reading "free". A take from anyone else bumps the
 * generation and clears any hand-off request, which was addressed to the
 * previous holder; re-taking our own only renews it. **A fresh lease held by
 * another process is never taken** — that is the whole of the hand-off's
 * safety, and a standby asks for one rather than taking it.
 */
export function tryAcquireLease(holder: string, nowMs: number): LeaseAttempt {
  const db = getDb();
  return db
    .transaction((): LeaseAttempt => {
      const lease = readLease();
      if (lease.holder === holder) {
        db.prepare(`UPDATE engine_lease SET renewed_at = ? WHERE id = 1`).run(nowMs);
        return { acquired: true, holder, generation: lease.generation, renewedAt: nowMs };
      }
      if (lease.holder != null && !isStale(lease, nowMs)) {
        return {
          acquired: false,
          holder: lease.holder,
          generation: lease.generation,
          renewedAt: lease.renewedAt,
        };
      }
      const generation = lease.generation + 1;
      db.prepare(
        `UPDATE engine_lease
            SET holder = ?, generation = ?, acquired_at = ?, renewed_at = ?,
                handoff_requested_by = NULL, handoff_requested_at = NULL
          WHERE id = 1`,
      ).run(holder, generation, nowMs, nowMs);
      return { acquired: true, holder, generation, renewedAt: nowMs };
    })
    .immediate();
}

/** Re-stamp the lease if it is still ours. False means another process has
 *  taken it — the caller is no longer the engine. */
export function renewLease(holder: string, nowMs: number): boolean {
  const result = getDb()
    .prepare(`UPDATE engine_lease SET renewed_at = ? WHERE id = 1 AND holder = ?`)
    .run(nowMs, holder);
  return result.changes === 1;
}

/** Give the lease up so the next process takes it at once. A no-op when it
 *  is not ours: a release must never clear another holder's claim. */
export function releaseLease(holder: string): boolean {
  const result = getDb()
    .prepare(`UPDATE engine_lease SET holder = NULL, renewed_at = NULL WHERE id = 1 AND holder = ?`)
    .run(holder);
  return result.changes === 1;
}

const RELEASED_FOR_EXIT_KEY = "__crossfireEngineLeaseReleasedForExit";
type GlobalWithReleased = typeof globalThis & { [RELEASED_FOR_EXIT_KEY]?: boolean };

/**
 * This process's last word on the lease, from its exit: after it, nothing of
 * this process runs, so no order it places can follow the release. Marked
 * before the write, so `holdsLease()` answers no without reading even if the
 * write throws — the process is ending either way.
 */
export function releaseLeaseForExit(): boolean {
  (globalThis as GlobalWithReleased)[RELEASED_FOR_EXIT_KEY] = true;
  return releaseLease(leaseHolderId());
}

/**
 * Does this process hold the engine lease. **The one reader every engine
 * entry point asks**; a door never writes its own comparison. Reads the row
 * rather than a flag set at acquisition, so a lease another process has
 * taken since is seen at once rather than at the next renew. A row that
 * cannot be read answers no. **It still reads after a stop signal has closed
 * the database**: the lease is held through the drain and released at the
 * exit, so a sweep or an exit in the drain is still the engine's. Only once
 * the exit has released it does this answer no without reading.
 */
export function holdsLease(): boolean {
  if ((globalThis as GlobalWithReleased)[RELEASED_FOR_EXIT_KEY] === true) return false;
  try {
    return readLease().holder === leaseHolderId();
  } catch {
    return false;
  }
}

/**
 * The gate a clock-driven sweep asks before it places a flatten: `holdsLease()`
 * at the call, and `reportLeaseRefused` once per loss rather than once per
 * pass — a sweep runs every 15–30s, and a lost lease is said by the renew's
 * `engine_lease_lost` too. A lease held again re-arms the report.
 */
export function leaseGate(door: string, consequence: string): () => boolean {
  let reported = false;
  return () => {
    if (holdsLease()) {
      reported = false;
      return true;
    }
    if (!reported) {
      reported = true;
      reportLeaseRefused(door, consequence);
    }
    return false;
  };
}

/** What a standby's ask found. */
export type HandoffAsk =
  /** Free or stale: the asker takes it with `tryAcquireLease`; no request was written. */
  | { kind: "take" }
  /** Held fresh by `holder`, now asked to yield to the asker. */
  | { kind: "requested"; holder: string; generation: number }
  /** Another standby's request still stands; nothing was written. */
  | { kind: "queued"; behind: string; holder: string };

function requestIsLive(at: number | null, nowMs: number): boolean {
  return at != null && nowMs - at <= HANDOFF_REQUEST_FRESH_MS;
}

/**
 * Ask the process holding a fresh lease to yield it to `requester`. Writes
 * the request **only** on a lease another process holds and has renewed
 * inside `LEASE_FRESH_MS`; a free, stale or own lease is the asker's to take,
 * not to ask for. **And never over another standby's live request**: the
 * first asker would read its next failed refresh as an acceptance, so a
 * second standby queues until the column clears. One `IMMEDIATE`
 * transaction, as the acquire is, so the read and the write are one step.
 */
export function requestHandoff(requester: string, nowMs: number): HandoffAsk {
  const db = getDb();
  return db
    .transaction((): HandoffAsk => {
      const lease = readLease();
      if (lease.holder == null || lease.holder === requester || isStale(lease, nowMs)) {
        return { kind: "take" };
      }
      const pending = lease.handoffRequestedBy;
      if (pending != null && pending !== requester && requestIsLive(lease.handoffRequestedAt, nowMs)) {
        return { kind: "queued", behind: pending, holder: lease.holder };
      }
      db.prepare(
        `UPDATE engine_lease SET handoff_requested_by = ?, handoff_requested_at = ? WHERE id = 1`,
      ).run(requester, nowMs);
      return { kind: "requested", holder: lease.holder, generation: lease.generation };
    })
    .immediate();
}

/**
 * Whether `holder` accepted the request: the column is clear and `holder`
 * still holds the lease. **The only reading of an acceptance** — a refresh
 * that finds the request gone may also mean another take or another asker.
 */
export function handoffAcceptedBy(holder: string): boolean {
  const lease = readLease();
  return lease.holder === holder && lease.handoffRequestedBy == null;
}

/**
 * The standby says it is still asking. False when the request is no longer
 * its own — the holder accepted it, another take cleared it, or another
 * standby asked over a request this one let lapse; `handoffAcceptedBy` says
 * which.
 */
export function refreshHandoffRequest(requester: string, nowMs: number): boolean {
  const result = getDb()
    .prepare(`UPDATE engine_lease SET handoff_requested_at = ? WHERE id = 1 AND handoff_requested_by = ?`)
    .run(nowMs, requester);
  return result.changes === 1;
}

/**
 * The process asking `holder` to yield, or null — none asked, the asker is
 * `holder` itself, `holder` no longer holds the lease, or **the request has
 * not been refreshed inside `HANDOFF_REQUEST_FRESH_MS`**: a standby killed
 * mid-wait leaves its request behind, and yielding to it would leave no engine.
 */
export function handoffRequestedBy(holder: string, nowMs: number): string | null {
  const lease = readLease();
  if (lease.holder !== holder) return null;
  const requester = lease.handoffRequestedBy;
  if (requester == null || requester === holder) return null;
  return requestIsLive(lease.handoffRequestedAt, nowMs) ? requester : null;
}

/**
 * The holder commits to yielding: clears the request, but only if it is
 * still `requester`'s, refreshed inside `HANDOFF_REQUEST_FRESH_MS`, on a
 * lease `holder` still holds — the freshness re-read in the same statement
 * as the clear. **One statement, and the standby's withdraw is the other
 * half of it**: whichever clears the column first wins, so a standby that
 * gave up at its bound can never meet an active that yields to nobody. A
 * standby killed outright inside the window can still be accepted; the
 * window is what bounds that.
 */
export function acceptHandoff(holder: string, requester: string, nowMs: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE engine_lease SET handoff_requested_by = NULL, handoff_requested_at = NULL
        WHERE id = 1 AND holder = ? AND handoff_requested_by = ? AND handoff_requested_at >= ?`,
    )
    .run(holder, requester, nowMs - HANDOFF_REQUEST_FRESH_MS);
  return result.changes === 1;
}

/** The standby gives up its request. False when the holder already accepted
 *  it (or the column names someone else): the holder is yielding. */
export function withdrawHandoff(requester: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE engine_lease SET handoff_requested_by = NULL, handoff_requested_at = NULL
        WHERE id = 1 AND handoff_requested_by = ?`,
    )
    .run(requester);
  return result.changes === 1;
}

/** Who holds the lease, as a log line names it. */
export function describeLeaseHolder(
  lease: Pick<EngineLease, "holder" | "generation" | "renewedAt">,
  nowMs: number,
): string {
  if (lease.holder == null) return "no process holds it";
  const renewed =
    lease.renewedAt == null
      ? "with no readable renewal time"
      : `last renewed ${Math.round((nowMs - lease.renewedAt) / 1000)}s ago (${new Date(lease.renewedAt).toISOString()})`;
  return `${lease.holder} holds it (generation ${lease.generation}), ${renewed}`;
}

/**
 * Say that an engine entry point refused for want of the lease. One reporter
 * for every door, so the line always names the holder and what was not done.
 */
export function reportLeaseRefused(door: string, reason?: string): void {
  let holder: string;
  try {
    holder = describeLeaseHolder(readLease(), Date.now());
  } catch (err) {
    holder = `the lease row could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  log.event(
    "engine_lease_refused",
    "engine",
    `Engine refused at ${door}: this process (${leaseHolderId()}) does not hold the engine lease, ` +
      `so nothing was started and no order placed. ${reason ? `${reason} ` : ""}Lease: ${holder}.`,
  );
}
