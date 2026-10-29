import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { passwordProblem, usernameProblem } from "@/lib/auth/web-account-rules";
import { getDb, registerMigration } from "./connection";

/**
 * The one local account the web UI signs in with. Not a broker credential and
 * never derived from one: the broker login proves the app can trade, this
 * proves the person at the browser may use it (brokers-client.md).
 *
 * One row, pinned to `id = 1`, so a second account cannot exist by
 * construction and two concurrent first-run creates resolve at the primary
 * key rather than in application code.
 */
registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS web_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
});

/**
 * OWASP's scrypt equivalents trade memory for passes at equal strength
 * (N=2^17,p=1 … N=2^13,p=10). This one is N=2^14, r=8, p=5: 16 MiB a hash,
 * under Node's 32 MiB `maxmem` default, so a burst of sign-ins on a process
 * that runs 24/7 cannot take 128 MiB a time from the engine beside it. The
 * parameters are stored in each hash, so raising them later still verifies
 * every hash written before.
 */
export const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 5, keyLength: 64, saltLength: 16 } as const;
const HASH_SCHEME = "scrypt";

interface CostParams {
  N: number;
  r: number;
  p: number;
}

interface StoredHash extends CostParams {
  salt: Buffer;
  key: Buffer;
}

function deriveKey(
  password: string,
  salt: Buffer,
  params: CostParams,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: params.N, r: params.r, p: params.p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const key = await deriveKey(password, salt, SCRYPT_PARAMS, SCRYPT_PARAMS.keyLength);
  const { N, r, p } = SCRYPT_PARAMS;
  return [HASH_SCHEME, N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

function parseStoredHash(stored: string): StoredHash | null {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== HASH_SCHEME || key === undefined) return null;
  return {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, "base64"),
    key: Buffer.from(key, "base64"),
  };
}

/** Constant-time over the derived key: the compare is `timingSafeEqual`, never `===`. */
export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;
  const candidate = await deriveKey(password, parsed.salt, parsed, parsed.key.length);
  return timingSafeEqual(candidate, parsed.key);
}

/** Fixed-length digests so the username compare is constant-time too and
 *  does not leak the stored name's length. */
function sameUsername(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

interface AccountRow {
  username: string;
  password_hash: string;
}

function readAccount(): AccountRow | null {
  const row = getDb()
    .prepare(`SELECT username, password_hash FROM web_account WHERE id = 1`)
    .get() as AccountRow | undefined;
  return row ?? null;
}

export function hasWebAccount(): boolean {
  return readAccount() !== null;
}

export type CreateWebAccountResult =
  | { ok: true }
  | { ok: false; reason: "exists" }
  | { ok: false; reason: "invalid"; message: string };

export async function createWebAccount(
  username: string,
  password: string,
  nowMs: number = Date.now(),
): Promise<CreateWebAccountResult> {
  const problem = usernameProblem(username) ?? passwordProblem(password);
  if (problem !== null) return { ok: false, reason: "invalid", message: problem };
  if (hasWebAccount()) return { ok: false, reason: "exists" };
  const passwordHash = await hashPassword(password);
  // The check above spares the hash on the common refusal; this is the one
  // that holds when two creates race past it.
  const inserted = getDb()
    .prepare(
      `INSERT INTO web_account (id, username, password_hash, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(username, passwordHash, nowMs, nowMs);
  return inserted.changes === 1 ? { ok: true } : { ok: false, reason: "exists" };
}

/**
 * True only when both halves match. The password is hashed whether or not the
 * username matched, so a wrong name costs the same time as a wrong password
 * and the answer cannot say which half was wrong.
 */
export async function verifyWebAccount(username: string, password: string): Promise<boolean> {
  const account = readAccount();
  if (account === null) return false;
  const nameOk = sameUsername(username, account.username);
  const passwordOk = await passwordMatches(password, account.password_hash);
  return nameOk && passwordOk;
}

/** The stored name, for the signed-in *Change password* route only — never
 *  for an unauthenticated response. */
export function webAccountUsername(): string | null {
  return readAccount()?.username ?? null;
}

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: "wrong-password" }
  | { ok: false; reason: "invalid"; message: string };

export async function changeWebAccountPassword(
  username: string,
  current: string,
  next: string,
  nowMs: number = Date.now(),
): Promise<ChangePasswordResult> {
  if (!(await verifyWebAccount(username, current))) return { ok: false, reason: "wrong-password" };
  const problem = passwordProblem(next);
  if (problem !== null) return { ok: false, reason: "invalid", message: problem };
  getDb()
    .prepare(`UPDATE web_account SET password_hash = ?, updated_at = ? WHERE id = 1`)
    .run(await hashPassword(next), nowMs);
  return { ok: true };
}

/** The factory reset's half: a reset install asks for a new account on its
 *  next first run, like it asks for new broker credentials. */
export function clearWebAccount(): void {
  getDb().prepare(`DELETE FROM web_account`).run();
}
