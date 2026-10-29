import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "@/lib/logger";
import { runsEngine } from "@/lib/role";

// Storage lives at TRADING_DB_PATH (or ./data/trading.db by default).
// In Docker, set TRADING_DB_PATH=/app/data/trading.db and mount a host
// volume to /app/data so the DB survives container rebuilds.
const DB_PATH = process.env.TRADING_DB_PATH ?? resolve(process.cwd(), "data", "trading.db");

let db: Database.Database | null = null;
type MigrateFn = (d: Database.Database) => void;
const pendingMigrations: MigrateFn[] = [];

type PreCloseHook = (signal: string) => void;

/**
 * The signal registration, the hooks and the open handles, per process rather
 * than per module instance. `next dev` re-evaluates this module on every hot
 * reload: a module-level guard added another SIGTERM/SIGINT pair each time
 * (Node warns at the eleventh), and the one handler that should run would
 * only see its own graph's hooks and connection. Parked on `globalThis` as
 * `engine-singleton.ts` is.
 */
interface ShutdownRegistry {
  handlersRegistered: boolean;
  /** Set when the stop sequence starts; it runs once per process. */
  shutdownStarted: boolean;
  /** Set once the signal's close has run; never cleared — the process is on its way out. */
  closedForShutdown: boolean;
  hooks: PreCloseHook[];
  afterCloseHooks: PreCloseHook[];
  handles: Set<Database.Database>;
}
const SHUTDOWN_GLOBAL_KEY = "__crossfireDbShutdown";
type GlobalWithShutdown = typeof globalThis & { [SHUTDOWN_GLOBAL_KEY]?: ShutdownRegistry };

function shutdownRegistry(): ShutdownRegistry {
  const g = globalThis as GlobalWithShutdown;
  g[SHUTDOWN_GLOBAL_KEY] ??= {
    handlersRegistered: false,
    shutdownStarted: false,
    closedForShutdown: false,
    hooks: [],
    afterCloseHooks: [],
    handles: new Set(),
  };
  return g[SHUTDOWN_GLOBAL_KEY];
}

/**
 * Register a **synchronous** DB write to run on SIGTERM / SIGINT, before the
 * connection closes.
 *
 * This exists so the clean-shutdown marker (D-13 of
 * docs/proposals/position-lifecycle.md) cannot lose a race it would otherwise
 * lose by accident. The close handler below is registered on the first
 * `getDb()`, which happens very early, and `process.once` runs handlers in
 * registration order — so any module registering its own signal handler later
 * would find the database already closed. Hooking into the close path instead
 * makes the ordering structural rather than a property of import order.
 *
 * Hooks must not await: the SIGTERM→SIGKILL window is finite (30s in the
 * deploy pipeline, and whatever the operator's `docker stop` says everywhere
 * else), and anything that yields is not guaranteed to resume. A throwing hook
 * is logged and skipped — a marker that could not be written must never block
 * the close.
 */
export function registerPreCloseHook(fn: PreCloseHook): void {
  shutdownRegistry().hooks.push(fn);
}

/**
 * Register a synchronous step to run on SIGTERM / SIGINT **after** every
 * pre-close hook and the close — for releasing what holds the process open
 * (an SSE response, the exit bound), never for a write.
 *
 * A phase of its own rather than a late pre-close hook so that nothing
 * registered here can run ahead of the clean-shutdown marker, whatever order
 * the modules loaded in. It runs whether or not a connection was open.
 */
export function registerAfterCloseHook(fn: PreCloseHook): void {
  shutdownRegistry().afterCloseHooks.push(fn);
}

/**
 * Whether a SIGTERM / SIGINT has closed the database. A background writer
 * (the log store's flush timer) checks it, because `getDb()` reopens a closed
 * handle and nothing may write after the close.
 */
export function isClosedForShutdown(): boolean {
  return shutdownRegistry().closedForShutdown;
}

/**
 * Whether the stop sequence has begun — a signal or a hand-off's yield. Set
 * before the first hook runs, so a caller between its own awaits sees a stop
 * the moment it starts. A standby asks it while it polls for the lease: a
 * standby on its way out must not take the engine.
 */
export function isShutdownStarted(): boolean {
  return shutdownRegistry().shutdownStarted;
}

/**
 * The stop sequence — every pre-close hook, the close, every after-close hook
 * — that a stop signal runs, callable without one. The engine's hand-off
 * yields through it with `trigger` naming the hand-off, so a yield is the
 * SIGTERM path with the request in place of the signal rather than a copy of
 * it. Once per process: a signal that arrives after a hand-off started, or a
 * second signal, finds it already run.
 */
export function runShutdownSequence(trigger: string): void {
  const registry = shutdownRegistry();
  if (registry.shutdownStarted) return;
  registry.shutdownStarted = true;
  closeHandles(registry, trigger);
  registry.closedForShutdown = true;
  for (const hook of registry.afterCloseHooks) {
    try {
      hook(trigger);
    } catch (err) {
      log.event("db_close_failed", "db", `after-close hook on ${trigger} failed`, { meta: err });
    }
  }
}

function registerShutdownHandlers(): void {
  const registry = shutdownRegistry();
  if (registry.handlersRegistered) return;
  registry.handlersRegistered = true;
  // Prepended, not appended (A51): `next dev` binds a SIGINT handler that
  // exits synchronously before the first `getDb()`, so an appended handler
  // never ran on Ctrl-C and every dev restart reported an unclean stop.
  process.prependOnceListener("SIGTERM", () => runShutdownSequence("SIGTERM"));
  process.prependOnceListener("SIGINT", () => runShutdownSequence("SIGINT"));
}

function closeHandles(registry: ShutdownRegistry, signal: string): void {
  try {
    const open = [...registry.handles].filter((h) => h.open);
    if (open.length === 0) return;
    // Every hook before any close: a hook writes through its own graph's
    // handle, which may not be the first one in the set.
    for (const hook of registry.hooks) {
      try {
        hook(signal);
      } catch (err) {
        log.event("db_close_failed", "db", `pre-close hook on ${signal} failed`, {
          meta: err,
        });
      }
    }
    for (const handle of open) handle.close();
    registry.handles.clear();
    log.event("db_closed", "db", `closed cleanly on ${signal}`);
  } catch (err) {
    log.event("db_close_failed", "db", `close on ${signal} failed`, { meta: err });
  }
}

/** Register a migration to run once the DB is opened. Modules call this
 *  at import time so `getDb()` callers always get a fully-migrated handle.
 *  Only a process that runs the engine migrates; a `web` process waits for
 *  the schema instead (`awaitEngineSchema`). */
export function registerMigration(fn: MigrateFn): void {
  pendingMigrations.push(fn);
  if (db && runsEngine()) fn(db);
}

/** Every migration registered so far. Read by `schema-version.test.ts`, which
 *  pins their source against `SCHEMA_VERSION`. */
export function registeredMigrations(): readonly MigrateFn[] {
  return pendingMigrations;
}

/**
 * How long a write waits on another connection's lock before SQLITE_BUSY.
 * better-sqlite3 already opens with this value; the pragma restates it so the
 * wait two processes on one file depend on is stated here rather than
 * inherited from a library default. Set in every role, `all` included.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * The schema this build expects, stamped as `PRAGMA user_version` by the
 * process that migrates once its module graph has registered every
 * migration. **Bump it with any `registerMigration` block added or changed**:
 * a `web` process waits for it, and a stale number lets the web side read a
 * table the engine has not migrated yet. `schema-version.test.ts` fails on a
 * changed block with this unchanged. It is not a record of which
 * migrations ran — every block still runs on every engine open (README,
 * *Decisions*).
 */
export const SCHEMA_VERSION = 3;
const SCHEMA_POLL_MS = 1_000;
const SCHEMA_WAIT_MS = 60_000;

export function getDb(): Database.Database {
  if (db?.open) return db;
  // Read before the open, so an unknown role throws on every call rather
  // than once and then hands back an unmigrated handle.
  const migrates = runsEngine();
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  // First: the WAL switch below takes a lock another process may hold.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (migrates) {
    for (const fn of pendingMigrations) fn(db);
  }
  shutdownRegistry().handles.add(db);
  registerShutdownHandlers();
  return db;
}

function schemaVersion(): number {
  return getDb().pragma("user_version", { simple: true }) as number;
}

/** Engine side: say the schema is this build's. Called once the module graph
 *  that registers the migrations has loaded and run them. */
export function markSchemaCurrent(): void {
  if (!runsEngine()) return;
  getDb().pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Web side: wait until the engine process has migrated the database to this
 * build's schema, polling every second for up to a minute, then throw naming
 * both versions. A newer schema than this build's is fine — the engine
 * migrated ahead of a web process that has not been redeployed.
 */
export async function awaitEngineSchema(): Promise<void> {
  const started = Date.now();
  for (;;) {
    const found = schemaVersion();
    if (found >= SCHEMA_VERSION) return;
    if (Date.now() - started >= SCHEMA_WAIT_MS) {
      throw new Error(
        `database schema is at version ${found} and this build needs ${SCHEMA_VERSION} — ` +
          `the engine process has not migrated it after ${SCHEMA_WAIT_MS / 1000}s`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SCHEMA_POLL_MS));
  }
}
