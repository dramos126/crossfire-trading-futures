import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PRACTICE_ONLY_KEY,
  SELECTED_ACCOUNT_KEY_LIVE,
  SELECTED_ACCOUNT_KEY_PRACTICE,
  migrateLegacyStorageKeys,
  readAnyStoredAccountId,
  readStoredAccountIdFor,
  readStoredPracticeOnly,
} from "./account-selection";

/** Minimal in-memory `Storage`. The container reads bare `localStorage`,
 *  so the stub has to satisfy the real interface, not a subset. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("migrateLegacyStorageKeys", () => {
  it("carries a stored practice-only setting across the container rename", () => {
    storage.setItem("topstep_practice_only", "true");

    expect(readStoredPracticeOnly()).toBe(true);
    expect(storage.getItem(PRACTICE_ONLY_KEY)).toBe("true");
    expect(storage.getItem("topstep_practice_only")).toBeNull();
  });

  it("carries a stored practice-only setting of false, not just true", () => {
    storage.setItem("topstep_practice_only", "false");

    expect(readStoredPracticeOnly()).toBe(false);
  });

  it("carries both per-mode account selections across the rename", () => {
    storage.setItem("topstep_selected_account_id_practice", "111");
    storage.setItem("topstep_selected_account_id_live", "222");

    migrateLegacyStorageKeys();

    expect(storage.getItem(SELECTED_ACCOUNT_KEY_PRACTICE)).toBe("111");
    expect(storage.getItem(SELECTED_ACCOUNT_KEY_LIVE)).toBe("222");
    expect(storage.getItem("topstep_selected_account_id_practice")).toBeNull();
    expect(storage.getItem("topstep_selected_account_id_live")).toBeNull();
    expect(readStoredAccountIdFor(true)).toBe(111);
    expect(readStoredAccountIdFor(false)).toBe(222);
  });

  it("seeds both buckets from the pre-split single selection key", () => {
    storage.setItem("topstep_selected_account_id", "333");

    migrateLegacyStorageKeys();

    expect(storage.getItem(SELECTED_ACCOUNT_KEY_PRACTICE)).toBe("333");
    expect(storage.getItem(SELECTED_ACCOUNT_KEY_LIVE)).toBe("333");
    expect(storage.getItem("topstep_selected_account_id")).toBeNull();
  });

  it("prefers the per-mode selection over the pre-split one when both exist", () => {
    storage.setItem("topstep_selected_account_id", "333");
    storage.setItem("topstep_selected_account_id_live", "222");

    migrateLegacyStorageKeys();

    expect(storage.getItem(SELECTED_ACCOUNT_KEY_LIVE)).toBe("222");
    // The pre-split key still seeds the bucket the per-mode key did not fill.
    expect(storage.getItem(SELECTED_ACCOUNT_KEY_PRACTICE)).toBe("333");
  });

  it("never overwrites a value already stored under the current name", () => {
    storage.setItem(PRACTICE_ONLY_KEY, "false");
    storage.setItem(SELECTED_ACCOUNT_KEY_LIVE, "999");
    storage.setItem("topstep_practice_only", "true");
    storage.setItem("topstep_selected_account_id_live", "222");

    migrateLegacyStorageKeys();

    expect(storage.getItem(PRACTICE_ONLY_KEY)).toBe("false");
    expect(storage.getItem(SELECTED_ACCOUNT_KEY_LIVE)).toBe("999");
    expect(storage.getItem("topstep_practice_only")).toBeNull();
    expect(storage.getItem("topstep_selected_account_id_live")).toBeNull();
  });

  it("is idempotent and writes nothing when no legacy key is present", () => {
    migrateLegacyStorageKeys();
    expect(storage.length).toBe(0);

    storage.setItem("topstep_selected_account_id_practice", "111");
    migrateLegacyStorageKeys();
    migrateLegacyStorageKeys();

    expect(storage.getItem(SELECTED_ACCOUNT_KEY_PRACTICE)).toBe("111");
    expect(storage.length).toBe(1);
  });

  it("leaves Topstep credential keys alone — they are not container keys", () => {
    storage.setItem("topstep_username", "operator");
    storage.setItem("topstep_api_key", "secret");
    storage.setItem("topstep_creds_validated_signature", "abc123");

    migrateLegacyStorageKeys();

    expect(storage.getItem("topstep_username")).toBe("operator");
    expect(storage.getItem("topstep_api_key")).toBe("secret");
    expect(storage.getItem("topstep_creds_validated_signature")).toBe("abc123");
  });
});

describe("readAnyStoredAccountId", () => {
  it("migrates before reading, so a legacy-only install is not seen as empty", () => {
    storage.setItem("topstep_selected_account_id_live", "222");

    expect(readAnyStoredAccountId()).toBe(222);
  });

  it("returns null on a non-numeric stored value", () => {
    storage.setItem(SELECTED_ACCOUNT_KEY_PRACTICE, "not-a-number");

    expect(readAnyStoredAccountId()).toBeNull();
  });
});
