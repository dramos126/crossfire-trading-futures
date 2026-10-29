import { getDb, isClosedForShutdown, registerMigration } from "./connection";
import {
  resetLogBursts,
  setLogSink,
  type BurstUpdate,
  type LegacyLogEntry,
  type LogRecord,
} from "@/lib/logging/pipe";

/**
 * Persistent storage for engine logs so /logs survives container redeploys.
 * Three design choices worth knowing:
 *
 *   1. Writes are queued and flushed in batches. The engine's `this.log()`
 *      fires from hot loops (per-tick BE check, per-reconcile pass), and
 *      since the log pipe landed every `log.*` line arrives here too; a
 *      synchronous DB write per call would put a `fsync` on the hot path.
 *      The queue lets the caller return in microseconds; the flush
 *      amortizes the disk hit across many entries. Worst case on a hard
 *      crash is up to FLUSH_INTERVAL_MS of unflushed entries lost —
 *      acceptable for log persistence (it's not transactional data).
 *
 *   2. This module is the pipe's sink, registered at import time rather
 *      than at engine construction, so a line emitted during boot is
 *      already being queued before the engine exists. `setLogSink` is the
 *      only direction that works: `connection.ts` imports the logger, so
 *      an import from `logging/` into `db/` would close a cycle.
 *
 *   3. **Messages arrive already scrubbed and are not re-scrubbed here.**
 *      Redaction is a write-time property of the pipe and has exactly one
 *      owner; see docs/modules/logging/README.md. A second pass here would
 *      be a second copy of the rule to keep in step with the first.
 */

/**
 * The structured columns the log envelope writes. All nullable with no
 * default, which is the only reading that stays honest: a row written
 * before the pipe existed carries NULL, meaning "no envelope", not a
 * manufactured severity or a burst of one.
 *
 * `level` is **not** among them and is still written on every row. The
 * viewer's lanes stopped facing it — they face severity and category — but
 * the wire payload is still bucketed by it (`getLogsByLevel`), one cap per
 * bucket, which is what keeps a low-frequency level visible at a small
 * limit. Retiring the column means re-keying that cap first.
 */
const ENVELOPE_COLUMNS: ReadonlyArray<[name: string, type: string]> = [
  ["severity", "TEXT"],
  ["category", "TEXT"],
  ["event", "TEXT"],
  ["display", "TEXT"],
  ["account_id", "INTEGER"],
  ["contract_id", "TEXT"],
  // The rendered symbol (`MNQ`), which is what an Activity sentence names.
  // Distinct from `contract_id` deliberately: one is the broker’s identifier
  // and stays server-side, the other is public market vocabulary and crosses.
  ["ticker", "TEXT"],
  ["trade_id", "INTEGER"],
  // The Activity template's value slots, as one JSON object. **Named
  // `slot_values` because `values` is a SQLite keyword** and
  // `ADD COLUMN values` is a syntax error; the envelope field keeps the
  // shorter name. JSON rather than a column per slot: the slots are a
  // rendering vocabulary that grows with the templates, and nothing
  // queries one — a row is read back whole or not at all.
  ["slot_values", "TEXT"],
  ["burst_key", "TEXT"],
  ["burst_count", "INTEGER"],
  ["last_seen_at", "TEXT"],
];

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS engine_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    -- Hydration query reads (level, timestamp DESC) — heartbeat ring loads
    -- N most-recent heartbeats, main ring loads N most-recent non-heartbeats.
    CREATE INDEX IF NOT EXISTS idx_engine_logs_level_ts ON engine_logs(level, timestamp DESC);
    -- Retention sweep deletes by timestamp.
    CREATE INDEX IF NOT EXISTS idx_engine_logs_ts ON engine_logs(timestamp);
  `);
  const cols = d.prepare(`PRAGMA table_info(engine_logs)`).all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  for (const [name, type] of ENVELOPE_COLUMNS) {
    if (!has(name)) d.exec(`ALTER TABLE engine_logs ADD COLUMN ${name} ${type}`);
  }
  d.exec(`
    -- L4's diagnostics lane facets on severity; the ladder is the filter
    -- the seven-chip enum could not express.
    CREATE INDEX IF NOT EXISTS idx_engine_logs_severity_ts ON engine_logs(severity, timestamp DESC);
    -- The Activity lane groups an entry→exit episode by trade_id.
    CREATE INDEX IF NOT EXISTS idx_engine_logs_trade ON engine_logs(trade_id);
  `);
});

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 100;
// Retention window. Anything older gets pruned at boot + once daily.
const RETENTION_DAYS = 30;
// Hydration limits. Match the in-memory ring caps in engine-singleton.ts so
// a redeploy lands the UI in roughly the same state it was before restart.
const HYDRATE_MAIN_LIMIT = 2000;
const HYDRATE_HEARTBEAT_LIMIT = 500;

let queue: LogRecord[] = [];
/**
 * Pending burst counts, keyed on the row they name. A Map rather than a
 * list because a burst bumps once per repeat and only the last count
 * matters — twenty-three repeats are one UPDATE, not twenty-three.
 */
let burstQueue = new Map<string, BurstUpdate>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let flushStarted = false;
let retentionStarted = false;

/** Queue a log for persistence. Cheap — just an array push. The flush
 *  loop drains to disk. */
export function persistEngineLog(log: LogRecord): void {
  queue.push(log);
  if (queue.length >= FLUSH_BATCH_SIZE) flush();
}

/** The row a burst update names. Timestamp first: it is fixed-width ISO,
 *  so the split point is unambiguous whatever a cause key contains. */
function burstRowKey(u: BurstUpdate): string {
  return `${u.timestamp}|${u.burstKey}`;
}

/** Queue a burst count. Never triggers a flush of its own — the point of
 *  collapsing is that repeats cost nothing until the cadence comes round. */
export function persistBurstUpdate(update: BurstUpdate): void {
  burstQueue.set(burstRowKey(update), update);
}

const INSERT_SQL = `INSERT INTO engine_logs
   (timestamp, deployment_id, level, message,
    severity, category, event, display, account_id, contract_id, ticker, trade_id,
    slot_values, burst_key, burst_count, last_seen_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const BURST_UPDATE_SQL = `UPDATE engine_logs SET burst_count = ?, last_seen_at = ?
   WHERE burst_key = ? AND timestamp = ?`;

/** The slot values as one JSON object, or NULL for a line that named none.
 *  Null rather than `"{}"`, so "no values" reads the same as every other
 *  envelope column a legacy row is missing. */
function serializeValues(values: LogRecord["values"]): string | null {
  return values == null ? null : JSON.stringify(values);
}

/** Force a flush, unless the shutdown has closed the database. Synchronous because better-sqlite3's transactions are
 *  synchronous, and the SIGTERM/SIGINT path needs the rows on disk before
 *  the process exits — there's no await for `process.once` handlers. */
export function flush(): void {
  // After the shutdown's close, `getDb()` would reopen the database for a
  // process that is exiting — the 5s timer outlives the close whenever the
  // exit waits on order work. Lines logged past the close wait for
  // `flushBeforeExit`.
  if (isClosedForShutdown()) return;
  writeQueued();
}

/**
 * The one write after the shutdown's close, made by the SIGTERM exit just
 * before `process.exit`, and allowed to reopen the database. The drain waits
 * for flattens and engine orders, and their lines — `flatten_all_complete`,
 * the force-flat's, the engine's order lines — are queued after the close;
 * without this they reach the console and never `/logs`.
 */
export function flushBeforeExit(): void {
  writeQueued();
}

function writeQueued(): void {
  if (queue.length === 0 && burstQueue.size === 0) return;
  const batch = queue;
  const bursts = Array.from(burstQueue.values());
  queue = [];
  burstQueue = new Map();
  try {
    const db = getDb();
    const insert = db.prepare(INSERT_SQL);
    const bump = db.prepare(BURST_UPDATE_SQL);
    const tx = db.transaction((rows: LogRecord[], updates: BurstUpdate[]) => {
      for (const r of rows) {
        insert.run(
          r.timestamp,
          r.deploymentId,
          r.level,
          r.message,
          r.severity,
          r.category,
          r.event,
          r.display,
          r.accountId,
          r.contractId,
          r.ticker,
          r.tradeId,
          serializeValues(r.values),
          r.burstKey,
          r.burstCount,
          r.lastSeenAt,
        );
      }
      // Inserts first. A burst opened inside this same batch has its row
      // written a statement earlier, so the update lands on it rather than
      // on nothing.
      for (const u of updates) bump.run(u.count, u.lastSeenAt, u.burstKey, u.timestamp);
    });
    tx(batch, bursts);
  } catch {
    // Re-queue so the next flush retries. Bounded by RETENTION (no
    // infinite growth on a stuck DB).
    queue = batch.concat(queue);
    // A repeat that arrived while this flush was failing already carries a
    // higher count for the same row, so the newer entry wins.
    for (const u of bursts) {
      const key = burstRowKey(u);
      if (!burstQueue.has(key)) burstQueue.set(key, u);
    }
  }
}

/**
 * The pipe's sink, installed at import time. Every line — the engine's and
 * every `log.*` call — lands in the same batched queue, which is the point
 * of the pipe and the reason a hot path never sees a synchronous insert.
 */
setLogSink({ write: persistEngineLog, bump: persistBurstUpdate });

/** Load the most-recent N entries per ring from disk so a redeploy lands
 *  the /logs UI in roughly the same state it was before restart. Returns
 *  the entries in chronological order (oldest first) so callers can push
 *  them straight into a ring buffer. */
export function hydrateRings(): { main: LegacyLogEntry[]; heartbeat: LegacyLogEntry[] } {
  try {
    const db = getDb();
    const mainRows = db.prepare(
      `SELECT timestamp, deployment_id, level, message
       FROM engine_logs
       WHERE level != 'heartbeat'
       ORDER BY timestamp DESC
       LIMIT ?`,
    ).all(HYDRATE_MAIN_LIMIT) as Array<{
      timestamp: string; deployment_id: string; level: string; message: string;
    }>;
    const heartbeatRows = db.prepare(
      `SELECT timestamp, deployment_id, level, message
       FROM engine_logs
       WHERE level = 'heartbeat'
       ORDER BY timestamp DESC
       LIMIT ?`,
    ).all(HYDRATE_HEARTBEAT_LIMIT) as Array<{
      timestamp: string; deployment_id: string; level: string; message: string;
    }>;
    const toLog = (r: {
      timestamp: string;
      deployment_id: string;
      level: string;
      message: string;
    }): LegacyLogEntry => ({
      timestamp: r.timestamp,
      deploymentId: r.deployment_id,
      level: r.level as LegacyLogEntry["level"],
      message: r.message,
    });
    return {
      main: mainRows.map(toLog).reverse(),
      heartbeat: heartbeatRows.map(toLog).reverse(),
    };
  } catch {
    return { main: [], heartbeat: [] };
  }
}

/** Delete rows older than RETENTION_DAYS. Runs at boot + once daily. */
function pruneExpired(): void {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    getDb().prepare(`DELETE FROM engine_logs WHERE timestamp < ?`).run(cutoff);
  } catch {
    // Sweep failures are non-fatal — the table will just grow until the
    // next successful run. Logged downstream by whoever notices.
  }
}

/** Start the flush + retention loops. Idempotent. Called once from
 *  engine-singleton when the engine is constructed. */
export function startEngineLogStore(): void {
  startEngineLogFlush();
  if (retentionStarted) return;
  retentionStarted = true;
  // Boot-time prune so a long-stopped install doesn't carry months of
  // stale logs forward on first start.
  pruneExpired();
  retentionTimer = setInterval(pruneExpired, 24 * 60 * 60 * 1000);
}

/** Start the flush loop alone. Idempotent. A `web` process's start: both
 *  roles flush their own lines into the table, and the retention sweep is
 *  the engine's — one sweeper is enough. */
export function startEngineLogFlush(): void {
  if (flushStarted) return;
  flushStarted = true;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  // Best-effort flush on graceful shutdown so the last batch isn't lost.
  // `prependOnceListener` runs BEFORE db/connection.ts's `close` handler
  // so the flush hits an open DB; without this, our flush race-loses to
  // `db.close()` and the unflushed batch is dropped.
  process.prependOnceListener("SIGTERM", flush);
  process.prependOnceListener("SIGINT", flush);
}

/** Wipe the persisted log table and drop any queued-but-unflushed entries.
 *  Paired with the in-memory ring wipe in engine-singleton.clearAllLogs(). */
export function clearPersistedLogs(): void {
  queue = [];
  burstQueue = new Map();
  // The open windows have to go with the rows. Left standing, the first
  // line of the next burst folds onto a row this DELETE just removed and
  // never reappears anywhere.
  resetLogBursts();
  try {
    getDb().prepare(`DELETE FROM engine_logs`).run();
  } catch {
    // Best-effort — UI already cleared the in-memory rings, so worst case
    // the persisted rows reappear on next redeploy.
  }
}

/** Test seam — stops timers so a Jest run doesn't keep the event loop
 *  alive. No-op outside tests. */
export function _stopEngineLogStoreForTest(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
  flushStarted = false;
  retentionStarted = false;
  burstQueue = new Map();
  resetLogBursts();
  setLogSink(null);
}
