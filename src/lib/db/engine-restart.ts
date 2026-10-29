// Durable restart state — the two signals D-13 of
// docs/proposals/position-lifecycle.md keeps deliberately apart, plus the
// flap counter D-14 needs.
//
//   last_seen_at      heartbeat, stamped while the process is alive — on the
//                     engine's tick and, independently of it, on the
//                     process-liveness interval that runs whether or not
//                     anything is deployed. Answers *how long the position
//                     went unmanaged*, which is what decides whether the next
//                     boot flattens. Survives every death mode, `kill -9`
//                     included, because it is written before the death rather
//                     than during it. **Idleness is not absence**: a stamp
//                     that advanced only on ticks made an idle box read its
//                     own quiet hours as unmanaged time (A57).
//   clean_shutdown_at marker, written from the SIGTERM path. Answers *was the
//                     stop intentional*, which decides whether the next boot
//                     alarms. Survives orderly stops only, by construction.
//   heartbeat_degraded_at
//                     marker, written from the tick when the heartbeat write
//                     itself failed. Answers *is `last_seen_at` measuring
//                     absence or a write failure*, and a boot that finds it
//                     refuses to read the gap as unmanaged time.
//   pending_flatten   the deployments still owed a downtime flatten, each with
//                     the instant its own obligation was taken on, plus the gap
//                     that produced the set. The obligation outlives the
//                     process that took it on — see below.
//
// Conflating them is the mistake the two columns exist to prevent: a redeploy
// must not flatten, and a crash that recovered in fifteen seconds must not
// flatten either — but it must still be audible, because a crash loop that
// recovers fast looks perfectly healthy from the position's point of view.
//
// One row, integer epoch-ms columns. No floating-point, no timezone, no
// ISO-string parse on the boot path that decides whether to close a position.
//
// **A partial write is not a reachable state.** Every writer here is a single
// prepared statement, which better-sqlite3 commits in its own implicit
// transaction, and the connection runs in WAL mode — a process killed
// mid-write leaves an uncommitted frame, so the next boot reads the previous
// value or none at all. For the marker specifically that means an interrupted
// write reads as *absent*, i.e. as a crash: a false alarm, never a false
// silence, and never a spurious flatten.

import { getDb, registerMigration } from "./connection";

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS engine_restart (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at INTEGER,
      clean_shutdown_at INTEGER,
      resume_cycles TEXT,
      pending_flatten TEXT,
      heartbeat_degraded_at INTEGER
    );
  `);
  // Nullable with no default, PRAGMA-guarded: a row written before these
  // existed has no owed flatten and no degraded heartbeat, and NULL is
  // exactly that answer.
  const cols = new Set(
    (d.prepare(`PRAGMA table_info(engine_restart)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("pending_flatten")) {
    d.exec(`ALTER TABLE engine_restart ADD COLUMN pending_flatten TEXT`);
  }
  if (!cols.has("heartbeat_degraded_at")) {
    d.exec(`ALTER TABLE engine_restart ADD COLUMN heartbeat_degraded_at INTEGER`);
  }
});

/** Every column is read back as `unknown`. The table is one hand-editable row
 *  on a mounted volume and each value below decides whether a live position is
 *  closed, so the reader validates rather than trusting the declared type. */
interface EngineRestartRow {
  last_seen_at: unknown;
  clean_shutdown_at: unknown;
  resume_cycles: unknown;
  pending_flatten: unknown;
  heartbeat_degraded_at: unknown;
}

/** One deployment's owed downtime flatten, and the instant that obligation
 *  was taken on. */
export interface OwedFlatten {
  deploymentId: string;
  /**
   * Epoch ms at which *this* obligation was recorded. **This is what gives the
   * entry a trade identity**: a deployment id alone says nothing about *which*
   * position is owed, and by the time the sweep runs the owed one may be gone
   * and a new one open on the same deployment. Every position an obligation is
   * about predates the boot that took it on, so a trade row that started after
   * this instant is not the one owed and is left alone.
   *
   * **Per entry, never per set.** Obligations merge — a carried one from a
   * previous boot with a fresh one this boot computed — and they were taken on
   * at different instants. One threshold across both refuses whatever the
   * *earlier* one refuses, which silently discards the later obligation's
   * position: it started after the carried instant, so it reads as "not the
   * one owed" while being exactly the one owed.
   *
   * Carried through a re-seed rather than re-stamped: a boot that restamps it
   * reopens the identity hole one boot later. `0` means absent — a legacy row
   * whose ids had no instant of their own, or a value nothing could parse.
   */
  seededAt: number;
}

/** The deployments still owed a downtime flatten, each with the instant its
 *  own obligation was taken on, plus the gap that produced the set. */
export interface PendingFlatten {
  entries: OwedFlatten[];
  /** How long the position went unmanaged, in ms. **Set-wide, deliberately**:
   *  it is a property of the outage rather than of a position, and it is
   *  carried because the boot that *acts* on the set is not necessarily the
   *  boot that measured it, so the log line must not report the later boot's
   *  gap. */
  gapMs: number;
}

export interface EngineRestartState {
  /** Epoch ms at which a process was last alive on this database, or null
   *  when none ever has been. Null means there is no gap to measure and
   *  therefore nothing for the duration rule to act on. */
  lastSeenAt: number | null;
  /** Epoch ms of the last recorded clean shutdown, or null. */
  cleanShutdownAt: number | null;
  /** Epoch ms of each unclean death→resume cycle still inside the flap
   *  window, oldest first. */
  resumeCycles: number[];
  /** What the previous process was still owed when it stopped. */
  pendingFlatten: PendingFlatten;
}

function readRow(): EngineRestartRow | undefined {
  return getDb()
    .prepare(
      `SELECT last_seen_at, clean_shutdown_at, resume_cycles, pending_flatten, heartbeat_degraded_at
         FROM engine_restart WHERE id = 1`,
    )
    .get() as EngineRestartRow | undefined;
}

/** An epoch-ms column that is not a finite number reads as absent. A hand
 *  edit, a legacy TEXT value or a NULL all land here, and every consumer of
 *  these two columns compares them against `Date.now()` — `NaN > threshold`
 *  is false, so the arithmetic already fails safe, but it renders as `NaN s`
 *  in an operator-facing Discord embed on the way. */
function epochOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** A corrupt or hand-edited `resume_cycles` reads as empty rather than
 *  throwing. The flap breaker suspends entries, so an unreadable counter must
 *  fail toward normal operation — refusing to trade on the strength of a
 *  value nothing can parse is the worse direction. */
function parseCycles(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  } catch {
    return [];
  }
}

/** Same defensive shape as {@link parseCycles}, and the opposite bias is worth
 *  naming: an unreadable flap counter fails toward *trading*, an unreadable
 *  owed set fails toward *not force-closing*. Both directions are "do the
 *  ordinary thing on a value nothing can parse", which is the only answer
 *  available — a set nothing can read is a set nothing can act on. What makes
 *  it safe is that the writer replaces the whole value in one statement, so
 *  there is no partial state to land in. */
function parsePendingFlatten(raw: unknown): PendingFlatten {
  const empty: PendingFlatten = { entries: [], gapMs: 0 };
  if (typeof raw !== "string" || raw.length === 0) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const rec = parsed as {
      entries?: unknown;
      deploymentIds?: unknown;
      gapMs?: unknown;
      seededAt?: unknown;
    };
    return { entries: parseOwedEntries(rec), gapMs: nonNegative(rec.gapMs) };
  } catch {
    return empty;
  }
}

/** Both payload shapes, current first.
 *
 * The legacy one — `{deploymentIds, seededAt}`, one instant for the whole set
 * — is a row this process did not write, so it is read rather than assumed
 * away: the set-wide instant applies to every id in it, which is exactly what
 * the boot that wrote it meant. An id whose instant is absent or unreadable in
 * either shape lands on `0` and is substituted at the read, in `readOwedFlatten`
 * and nowhere else. */
function parseOwedEntries(rec: {
  entries?: unknown;
  deploymentIds?: unknown;
  seededAt?: unknown;
}): OwedFlatten[] {
  if (Array.isArray(rec.entries)) {
    return rec.entries.flatMap((v) => {
      if (v === null || typeof v !== "object") return [];
      const entry = v as { deploymentId?: unknown; seededAt?: unknown };
      if (typeof entry.deploymentId !== "string" || entry.deploymentId.length === 0) return [];
      return [{ deploymentId: entry.deploymentId, seededAt: nonNegative(entry.seededAt) }];
    });
  }
  if (!Array.isArray(rec.deploymentIds)) return [];
  const seededAt = nonNegative(rec.seededAt);
  return rec.deploymentIds
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((deploymentId) => ({ deploymentId, seededAt }));
}

/** A non-negative finite number, or 0 for anything else. Every number in the
 *  owed set reads as "absent" rather than as `NaN`, which would reach a
 *  comparison that decides whether to close a live position. */
function nonNegative(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

export function readEngineRestartState(): EngineRestartState {
  const row = readRow();
  return {
    lastSeenAt: epochOrNull(row?.last_seen_at),
    cleanShutdownAt: epochOrNull(row?.clean_shutdown_at),
    resumeCycles: parseCycles(row?.resume_cycles),
    pendingFlatten: parsePendingFlatten(row?.pending_flatten),
  };
}

/**
 * Stamp the heartbeat. Two callers, saying the same thing from two places:
 * the engine's tick, and the process-liveness interval that runs whether or
 * not the engine has anything to trade. The tick one is the only write here
 * on a hot path — a single-row UPDATE by integer primary key, once per
 * `REST_TICK_MS`.
 */
export function stampEngineHeartbeat(nowMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO engine_restart (id, last_seen_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .run(nowMs);
}

/**
 * Record that this process is stopping on purpose. Synchronous, one
 * statement, and it must run *before* the connection closes — see the
 * pre-close hook in `connection.ts`, which is what orders it.
 */
export function markCleanShutdown(nowMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO engine_restart (id, clean_shutdown_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET clean_shutdown_at = excluded.clean_shutdown_at`,
    )
    .run(nowMs);
}

/**
 * Read the marker and clear it in one transaction. Consuming rather than
 * merely reading is what stops a marker from being counted twice: without the
 * clear, one clean shutdown would make every subsequent crash read as
 * intentional until the next clean shutdown overwrote it.
 */
export function consumeCleanShutdownMarker(): number | null {
  const db = getDb();
  return db.transaction(() => {
    const row = readRow();
    const marker = epochOrNull(row?.clean_shutdown_at);
    if (row?.clean_shutdown_at != null) {
      db.prepare(`UPDATE engine_restart SET clean_shutdown_at = NULL WHERE id = 1`).run();
    }
    return marker;
  })();
}

/**
 * Record that a process was alive and could not write its heartbeat.
 *
 * *Alive*, not *running*: both stampers reach this arm, and the liveness one
 * runs on an idle process with no tick loop behind it. What the marker claims
 * is that a write was attempted and refused — never that the engine was
 * ticking, and never that a stamp was declined.
 *
 * `last_seen_at` cannot tell "absent for twelve minutes" from "ticking for
 * twelve minutes and unable to say so", and the two want opposite responses —
 * the first is the flatten this table exists to trigger, the second is a
 * healthy engine whose positions must be left alone. This marker is the
 * difference, and it is written from the catch block of either stamper.
 *
 * **Best-effort by construction, and the caller must treat it that way.** The
 * channel it reports on is the one that just failed, so the write can fail
 * too; a wedged database leaves no marker and the next boot is back to today's
 * behaviour. It lands whenever the failure was per-statement or transient
 * across a 15s tick, which is the common shape of a lock or a WAL stall.
 */
export function markHeartbeatDegraded(nowMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO engine_restart (id, heartbeat_degraded_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET heartbeat_degraded_at = excluded.heartbeat_degraded_at`,
    )
    .run(nowMs);
}

/**
 * Read the degraded-heartbeat marker and clear it, like the clean-shutdown
 * marker and for the same reason: it describes the process that just ended,
 * so one degraded window must not disable the duration rule for every boot
 * after it.
 */
export function consumeHeartbeatDegradedMarker(): number | null {
  const db = getDb();
  return db.transaction(() => {
    const row = readRow();
    const marker = epochOrNull(row?.heartbeat_degraded_at);
    if (row?.heartbeat_degraded_at != null) {
      db.prepare(`UPDATE engine_restart SET heartbeat_degraded_at = NULL WHERE id = 1`).run();
    }
    return marker;
  })();
}

/**
 * Replace the durable record of which deployments are still owed a downtime
 * flatten.
 *
 * **The obligation has to outlive the process that took it on**, which is the
 * one property D-7 asked for by name. The sweep's own retry loop is the
 * likeliest thing to be interrupted: the broker being unreachable is the most
 * likely cause of the outage it is cleaning up after, so it retries and errors
 * for minutes, and the ordinary operator response to that log line is to
 * restart the container — which stamps a fresh heartbeat all the way through
 * the retries, so the next boot's *own* verdict is "keep". An in-memory set
 * disappears there, silently, and the position the system judged unsafe is
 * kept and traded.
 *
 * Whole-set replace in one statement, so there is no partial state: the next
 * boot reads the previous set or this one. Each entry travels with its own
 * `seededAt` for the reason given on the field: without it the ids name a
 * deployment rather than a position, and with one instant for the whole set
 * the earlier obligation's threshold discards the later obligation's position.
 */
export function setPendingFlatten(entries: readonly OwedFlatten[], gapMs: number): void {
  const payload: PendingFlatten = {
    entries: entries.map((e) => ({ deploymentId: e.deploymentId, seededAt: e.seededAt })),
    gapMs,
  };
  getDb()
    .prepare(
      `INSERT INTO engine_restart (id, pending_flatten) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET pending_flatten = excluded.pending_flatten`,
    )
    .run(JSON.stringify(payload));
}

/**
 * Append an unclean death→resume cycle, prune everything older than the
 * window, and return the surviving count including the one just added.
 *
 * The counter lives in the database rather than in the process because it
 * counts the process: an in-memory tally is reset by the exact event it
 * exists to count, so a crash loop would report one cycle forever. Pruning on
 * write means the window decays on its own — a run of stable boots does not
 * need anything to clear it.
 */
export function recordUncleanResume(nowMs: number, windowMs: number): number {
  const db = getDb();
  return db.transaction(() => {
    const row = readRow();
    const cycles = parseCycles(row?.resume_cycles);
    cycles.push(nowMs);
    const kept = cycles.filter((t) => nowMs - t <= windowMs).sort((a, b) => a - b);
    db.prepare(
      `INSERT INTO engine_restart (id, resume_cycles) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET resume_cycles = excluded.resume_cycles`,
    ).run(JSON.stringify(kept));
    return kept.length;
  })();
}
