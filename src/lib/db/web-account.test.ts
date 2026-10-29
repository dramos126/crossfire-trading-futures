/**
 * The web sign-in account. Real in-memory SQLite with the module's own
 * migration replayed (auth.test.ts's pattern), real scrypt — the hash is the
 * thing under test, so it is not stubbed.
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

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(real.timingSafeEqual);
  return { ...real, default: real, timingSafeEqual: timingSafeEqualSpy };
});

import {
  changeWebAccountPassword,
  clearWebAccount,
  createWebAccount,
  hasWebAccount,
  SCRYPT_PARAMS,
  verifyWebAccount,
  webAccountUsername,
} from "./web-account";
import { PASSWORD_TOO_SHORT_PROBLEM, USERNAME_LENGTH_PROBLEM } from "@/lib/auth/web-account-rules";

const NAME = "operator";
const PASSWORD = "correct horse battery";

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  timingSafeEqualSpy.mockClear();
});

function storedHash(): string {
  return (db.prepare(`SELECT password_hash FROM web_account`).get() as { password_hash: string })
    .password_hash;
}

describe("createWebAccount", () => {
  it("creates the one account and stores a salted scrypt hash, never the password", async () => {
    expect(hasWebAccount()).toBe(false);
    expect(await createWebAccount(NAME, PASSWORD)).toEqual({ ok: true });
    expect(hasWebAccount()).toBe(true);
    const hash = storedHash();
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith(`scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$`)).toBe(
      true,
    );
  });

  it("salts per hash — the same password twice stores two different hashes", async () => {
    await createWebAccount(NAME, PASSWORD);
    const first = storedHash();
    clearWebAccount();
    await createWebAccount(NAME, PASSWORD);
    expect(storedHash()).not.toBe(first);
  });

  it("refuses a second account, and the first one still signs in", async () => {
    await createWebAccount(NAME, PASSWORD);
    expect(await createWebAccount("intruder", "another long password")).toEqual({
      ok: false,
      reason: "exists",
    });
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(true);
    expect(await verifyWebAccount("intruder", "another long password")).toBe(false);
  });

  it("two creates racing past the existence check: exactly one wins", async () => {
    const results = await Promise.all([
      createWebAccount("first-one", PASSWORD),
      createWebAccount("second-one", PASSWORD),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM web_account`).get() as { n: number }).n).toBe(1);
  });

  it("holds the length rules: 12-character password minimum, 3–64 character username", async () => {
    expect(await createWebAccount(NAME, "elevenchars")).toEqual({
      ok: false,
      reason: "invalid",
      message: PASSWORD_TOO_SHORT_PROBLEM,
    });
    expect(await createWebAccount("ab", PASSWORD)).toEqual({
      ok: false,
      reason: "invalid",
      message: USERNAME_LENGTH_PROBLEM,
    });
    expect(await createWebAccount("a".repeat(65), PASSWORD)).toMatchObject({ reason: "invalid" });
    expect(hasWebAccount()).toBe(false);
    // Twelve characters exactly, all lower case: length is the only rule.
    expect(await createWebAccount("abc", "twelvecharss")).toEqual({ ok: true });
  });
});

describe("verifyWebAccount", () => {
  beforeEach(async () => {
    await createWebAccount(NAME, PASSWORD);
  });

  it("is true for the pair it was created with", async () => {
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(true);
  });

  it("is false when either half is wrong", async () => {
    expect(await verifyWebAccount(NAME, "wrong password here")).toBe(false);
    expect(await verifyWebAccount("someone-else", PASSWORD)).toBe(false);
  });

  it("is false with no account at all", async () => {
    clearWebAccount();
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(false);
  });

  it("compares with timingSafeEqual, and hashes the password even when the username is wrong", async () => {
    await verifyWebAccount("someone-else", PASSWORD);
    // One compare for the username digest, one for the derived key: the
    // wrong name did not short-circuit the slow half.
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
    const [candidate, stored] = timingSafeEqualSpy.mock.calls[1] as [Buffer, Buffer];
    expect(candidate).toHaveLength(SCRYPT_PARAMS.keyLength);
    expect(stored).toHaveLength(SCRYPT_PARAMS.keyLength);
  });
});

describe("changeWebAccountPassword", () => {
  const NEXT = "a different passphrase";

  beforeEach(async () => {
    await createWebAccount(NAME, PASSWORD);
  });

  it("needs the current password", async () => {
    expect(await changeWebAccountPassword(NAME, "not the password", NEXT)).toEqual({
      ok: false,
      reason: "wrong-password",
    });
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(true);
  });

  it("holds the new password to the length rule", async () => {
    expect(await changeWebAccountPassword(NAME, PASSWORD, "short")).toEqual({
      ok: false,
      reason: "invalid",
      message: PASSWORD_TOO_SHORT_PROBLEM,
    });
  });

  it("replaces the password: the old one stops working, the new one signs in", async () => {
    expect(await changeWebAccountPassword(NAME, PASSWORD, NEXT)).toEqual({ ok: true });
    expect(await verifyWebAccount(NAME, PASSWORD)).toBe(false);
    expect(await verifyWebAccount(NAME, NEXT)).toBe(true);
    expect(webAccountUsername()).toBe(NAME);
  });
});
