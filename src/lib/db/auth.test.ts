/**
 * Unit tests for the app-session half of auth.ts — the identity Phase E2
 * gave the app so it stops borrowing Topstep's JWT.
 *
 * Uses a real in-memory better-sqlite3 instance, the pattern
 * tradovate-order-map.test.ts established, so SQL semantics are exact. The
 * registered migration is captured from the mocked `registerMigration` and
 * replayed against the in-memory handle rather than restated here — a
 * hand-copied schema would let the shipped `CREATE TABLE` drift away from
 * the one under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import {
  APP_SESSION_TOUCH_INTERVAL_MS,
  APP_SESSION_TTL_MS,
  clearSession,
  createSession,
  hashSessionToken,
  jwtExpiry,
  revokeOtherSessions,
  revokeSession,
  sessionIsLive,
  validateSession,
} from "./auth";

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
});

function sessionCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM app_session`).get() as { n: number }).n;
}

describe("the migration that adds last_used_at", () => {
  it("drops every session minted before the password login — the deploy signs every open tab out", () => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE app_session (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO app_session VALUES (?, ?, ?)`).run(hashSessionToken("pre-login"), 1, Date.now() + APP_SESSION_TTL_MS);
    for (const fn of migrations) fn(db);
    expect(sessionCount()).toBe(0);
    expect(validateSession("pre-login")).toBe(false);
  });

  it("drops nothing on a later boot, once the column exists", () => {
    const token = createSession();
    for (const fn of migrations) fn(db);
    expect(validateSession(token)).toBe(true);
  });
});

describe("hashSessionToken", () => {
  it("returns a 64-character sha256 hex digest", () => {
    expect(hashSessionToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same input", () => {
    expect(hashSessionToken("abc")).toBe(hashSessionToken("abc"));
  });

  it("differs for different inputs", () => {
    expect(hashSessionToken("abc")).not.toBe(hashSessionToken("abd"));
  });
});

describe("sessionIsLive", () => {
  it("is true while the expiry is in the future", () => {
    expect(sessionIsLive(1_000, 999)).toBe(true);
  });

  it("is false exactly at the expiry", () => {
    expect(sessionIsLive(1_000, 1_000)).toBe(false);
  });

  it("is false after the expiry", () => {
    expect(sessionIsLive(1_000, 1_001)).toBe(false);
  });
});

describe("createSession", () => {
  it("returns an opaque token that is not a JWT", () => {
    const token = createSession();
    expect(token.length).toBeGreaterThan(20);
    expect(jwtExpiry(token)).toBeNull();
  });

  it("mints a distinct token each call", () => {
    expect(createSession()).not.toBe(createSession());
  });

  it("stores only the hash, never the token itself", () => {
    const token = createSession();
    const rows = db.prepare(`SELECT token_hash FROM app_session`).all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashSessionToken(token));
    expect(rows[0].token_hash).not.toBe(token);
  });

  it("sets a non-sliding 30-day expiry", () => {
    const now = 1_700_000_000_000;
    createSession(now);
    const row = db.prepare(`SELECT expires_at FROM app_session`).get() as {
      expires_at: number;
    };
    expect(row.expires_at).toBe(now + APP_SESSION_TTL_MS);
    expect(APP_SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("prunes expired rows as it mints", () => {
    const old = createSession(0);
    expect(validateSession(old, 0)).toBe(true);
    createSession(APP_SESSION_TTL_MS + 1);
    expect(sessionCount()).toBe(1);
  });

  it("keeps concurrent live sessions so a second tab does not evict the first", () => {
    const a = createSession();
    const b = createSession();
    expect(validateSession(a)).toBe(true);
    expect(validateSession(b)).toBe(true);
  });

  it("caps the table so page loads cannot grow it without bound", () => {
    const day = 24 * 60 * 60 * 1000;
    // Spread the mints across two days so the eviction floor has expired
    // for the older ones; a burst inside the floor is deliberately not
    // capped (see the next two cases).
    for (let i = 0; i < 130; i++) createSession(1_000 + i);
    createSession(1_000 + 2 * day);
    expect(sessionCount()).toBe(100);
  });

  it("does not evict a session younger than the eviction floor", () => {
    const live = createSession(1_000);
    // The unauthenticated-flood shape: enough mints to push the operator's
    // row well outside the newest N, all inside the floor window.
    for (let i = 0; i < 200; i++) createSession(2_000 + i);
    expect(validateSession(live, 3_000)).toBe(true);
  });

  it("evicts once the floor has passed", () => {
    const day = 24 * 60 * 60 * 1000;
    const old = createSession(1_000);
    for (let i = 0; i < 200; i++) createSession(2_000 + i);
    // One more mint a day later — `old` is now both outside the newest N
    // and past the floor.
    createSession(1_000 + day + 1);
    expect(validateSession(old, 1_000 + day + 1)).toBe(false);
  });

  it("evicts least recently used, not oldest minted — a polling tab survives the cap", () => {
    const day = 24 * 60 * 60 * 1000;
    const polling = createSession(1_000);
    const idle = createSession(1_500);
    for (let i = 0; i < 200; i++) createSession(2_000 + i);
    // The open tab's next gated request, a day later, touches its row.
    expect(validateSession(polling, day + 5_000)).toBe(true);
    createSession(2 * day + 10_000);
    expect(validateSession(polling, 2 * day + 10_000)).toBe(true);
    expect(validateSession(idle, 2 * day + 10_000)).toBe(false);
    expect(sessionCount()).toBe(100);
  });

  it("orders a row minted before last_used_at existed by its mint", () => {
    const day = 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO app_session (token_hash, created_at, expires_at, last_used_at) VALUES (?, ?, ?, NULL)`,
    ).run(hashSessionToken("legacy"), 1_000, 1_000 + APP_SESSION_TTL_MS);
    for (let i = 0; i < 100; i++) createSession(2_000 + i);
    createSession(2 * day);
    expect(validateSession("legacy", 2 * day)).toBe(false);
  });
});

describe("last_used_at", () => {
  function lastUsed(token: string): number | null {
    const row = db
      .prepare(`SELECT last_used_at FROM app_session WHERE token_hash = ?`)
      .get(hashSessionToken(token)) as { last_used_at: number | null };
    return row.last_used_at;
  }

  it("is stamped at mint", () => {
    expect(lastUsed(createSession(5_000))).toBe(5_000);
  });

  it("is touched at most once per interval — one write a minute, not one per request", () => {
    const token = createSession(0);
    expect(validateSession(token, APP_SESSION_TOUCH_INTERVAL_MS - 1)).toBe(true);
    expect(lastUsed(token)).toBe(0);
    expect(validateSession(token, APP_SESSION_TOUCH_INTERVAL_MS)).toBe(true);
    expect(lastUsed(token)).toBe(APP_SESSION_TOUCH_INTERVAL_MS);
  });

  it("is not touched by a refused token", () => {
    const now = 1_700_000_000_000;
    const token = createSession(now);
    expect(validateSession(token, now + APP_SESSION_TTL_MS)).toBe(false);
    expect(lastUsed(token)).toBe(now);
  });
});

describe("revokeSession / revokeOtherSessions", () => {
  it("sign-out drops only the presented session", () => {
    const a = createSession();
    const b = createSession();
    revokeSession(a);
    expect(validateSession(a)).toBe(false);
    expect(validateSession(b)).toBe(true);
  });

  it("a password change keeps the changing session and drops the rest", () => {
    const keep = createSession();
    const other = createSession();
    revokeOtherSessions(keep);
    expect(validateSession(keep)).toBe(true);
    expect(validateSession(other)).toBe(false);
  });
});

describe("validateSession", () => {
  it("accepts a freshly minted token", () => {
    expect(validateSession(createSession())).toBe(true);
  });

  it("rejects a token that was never minted", () => {
    createSession();
    expect(validateSession("not-a-session")).toBe(false);
  });

  it("rejects the empty string without touching the table", () => {
    expect(validateSession("")).toBe(false);
  });

  it("rejects an arbitrary non-empty string — presence is not proof", () => {
    expect(validateSession("x")).toBe(false);
  });

  it("rejects the stored hash presented as the token", () => {
    const token = createSession();
    expect(validateSession(hashSessionToken(token))).toBe(false);
  });

  it("rejects a token past its expiry", () => {
    const now = 1_700_000_000_000;
    const token = createSession(now);
    expect(validateSession(token, now + APP_SESSION_TTL_MS - 1)).toBe(true);
    expect(validateSession(token, now + APP_SESSION_TTL_MS)).toBe(false);
  });
});

describe("clearSession", () => {
  it("invalidates every outstanding session", () => {
    const a = createSession();
    const b = createSession();
    clearSession();
    expect(sessionCount()).toBe(0);
    expect(validateSession(a)).toBe(false);
    expect(validateSession(b)).toBe(false);
  });
});

describe("jwtExpiry", () => {
  it("returns the exp claim of a well-formed JWT", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1234 })).toString("base64url");
    expect(jwtExpiry(`aaa.${payload}.bbb`)).toBe(1234);
  });

  it("returns null when the token is not three segments", () => {
    expect(jwtExpiry("not.a.jwt.at.all")).toBeNull();
  });

  it("returns null when the payload is not JSON", () => {
    expect(jwtExpiry("aaa.bbb.ccc")).toBeNull();
  });
});
