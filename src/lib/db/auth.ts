import { createHash, randomBytes } from "node:crypto";
import { getDb, registerMigration } from "./connection";
// The login account sits beside the session it unlocks. Imported for its
// migration: Topstep's token cache reaches this file from the boot graph,
// and a migrating module outside that graph is never created on a split
// install (persistence README).
import "./web-account";

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS auth_token (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS engine_auth_token (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_session (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // The column arrived with the password login, so a table without it holds
  // exactly the sessions minted before there was a password — handed to
  // anyone who reached the port. They are dropped, not carried for the rest
  // of their 30 days: the deploy signs every open tab out, which is the point.
  // The DELETE goes first: the column's absence is the only record that it
  // has not run, so a death after an ALTER-first would keep those sessions.
  const columns = d.prepare(`PRAGMA table_info(app_session)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "last_used_at")) {
    d.exec(`DELETE FROM app_session;`);
    d.exec(`ALTER TABLE app_session ADD COLUMN last_used_at INTEGER;`);
  }
});

interface AuthTokenRow {
  token: string;
  expires_at: number;
}

export interface CachedToken {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

export function getCachedToken(): CachedToken | null {
  const row = getDb()
    .prepare(`SELECT token, expires_at FROM auth_token WHERE id = 1`)
    .get() as AuthTokenRow | undefined;
  if (!row) return null;
  return { token: row.token, expiresAt: row.expires_at };
}

export function setCachedToken(token: string, expiresAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO auth_token (id, token, expires_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
    )
    .run(token, expiresAt);
}

export function clearCachedToken(): void {
  getDb().prepare(`DELETE FROM auth_token WHERE id = 1`).run();
}

// `engine_auth_token` is a legacy table from when engine + browser kept
// separate caches; it's still in the migration for back-compat with prod
// volumes but is no longer read or written. Both paths share `auth_token`.

// ── App session ────────────────────────────────────────────────────────
//
// The app's OWN identity, and a third concern in this file — unrelated to
// `auth_token` (a cache of Topstep's browser JWT) and to the legacy
// `engine_auth_token`. Do not fold it into either: borrowing Topstep's JWT
// as the app session is exactly the coupling Phase E2 removed, and a
// Tradovate-only install has no Topstep JWT to borrow.
//
// The token is opaque — random bytes, never a JWT, nothing parses it. Only
// its sha256 is persisted, so a stolen database file carries no usable
// session.

/** Non-sliding. A session is 30 days from mint, then it is gone. */
export const APP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows kept, most recently used first. Every sign-in mints one and
 *  nothing reuses a row, so an uncapped table would grow with sign-ins for
 *  the whole 30-day TTL. */
const APP_SESSION_MAX_ROWS = 100;

/** A row used more recently than this is never dropped by the cap, so the
 *  cap is a soft one. Kept from when eviction ran by mint order and an
 *  unauthenticated `/api/auth` could flood the table; with a password in
 *  front of every mint and the order now least-recently-used, it only
 *  matters to a burst of real sign-ins. */
const APP_SESSION_EVICTION_FLOOR_MS = 24 * 60 * 60 * 1000;

/** How stale `last_used_at` may get before `validateSession` rewrites it.
 *  Every gated request validates, and a dashboard polls several routes
 *  every few seconds, so an unthrottled touch is a write per request; at
 *  this interval it is one write a minute per open session, and a minute
 *  of staleness is nothing against a cap that evicts after a day. */
export const APP_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

/** The order eviction reads. The migration leaves no row without
 *  `last_used_at`; the fallback is for a write that ever omits it. */
const LAST_USED = "COALESCE(last_used_at, created_at)";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Split out from `validateSession` so the expiry rule is testable without
 *  a database. Expiry is exclusive: a session dies the millisecond it hits
 *  `expiresAt`. */
export function sessionIsLive(expiresAt: number, nowMs: number): boolean {
  return expiresAt > nowMs;
}

/** Mint an app session and return the raw token — the only moment it
 *  exists in plaintext anywhere. */
export function createSession(nowMs: number = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  const db = getDb();
  db.prepare(`DELETE FROM app_session WHERE expires_at <= ?`).run(nowMs);
  db.prepare(
    `INSERT INTO app_session (token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?)`,
  ).run(hashSessionToken(token), nowMs, nowMs + APP_SESSION_TTL_MS, nowMs);
  db.prepare(
    `DELETE FROM app_session
      WHERE ${LAST_USED} <= ?
        AND token_hash NOT IN (
          SELECT token_hash FROM app_session ORDER BY ${LAST_USED} DESC, rowid DESC LIMIT ?
        )`,
  ).run(nowMs - APP_SESSION_EVICTION_FLOOR_MS, APP_SESSION_MAX_ROWS);
  return token;
}

/** Validates and, at most once per `APP_SESSION_TOUCH_INTERVAL_MS`, stamps
 *  `last_used_at` — so a tab that is polling can never be the row the cap
 *  evicts. */
export function validateSession(token: string, nowMs: number = Date.now()): boolean {
  if (!token) return false;
  const db = getDb();
  const tokenHash = hashSessionToken(token);
  const row = db
    .prepare(`SELECT expires_at, ${LAST_USED} AS last_used FROM app_session WHERE token_hash = ?`)
    .get(tokenHash) as { expires_at: number; last_used: number } | undefined;
  if (!row || !sessionIsLive(row.expires_at, nowMs)) return false;
  if (nowMs - row.last_used >= APP_SESSION_TOUCH_INTERVAL_MS) {
    db.prepare(`UPDATE app_session SET last_used_at = ? WHERE token_hash = ?`).run(nowMs, tokenHash);
  }
  return true;
}

/** Drop one session — sign-out. */
export function revokeSession(token: string): void {
  getDb().prepare(`DELETE FROM app_session WHERE token_hash = ?`).run(hashSessionToken(token));
}

/** Drop every session but `keepToken`'s — a password change signs every
 *  other browser out, because whoever holds one may be why it changed. */
export function revokeOtherSessions(keepToken: string): void {
  getDb()
    .prepare(`DELETE FROM app_session WHERE token_hash != ?`)
    .run(hashSessionToken(keepToken));
}

/** Drop every session. Called by the factory reset — the credentials that
 *  authenticated the session are gone, so the session goes with them. */
export function clearSession(): void {
  getDb().prepare(`DELETE FROM app_session`).run();
}

/** Decode the `exp` claim from a JWT without verifying the signature — we
 *  just need the expiry to decide when to refresh. Returns Unix seconds, or
 *  null if the token isn't a parseable JWT. */
export function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
