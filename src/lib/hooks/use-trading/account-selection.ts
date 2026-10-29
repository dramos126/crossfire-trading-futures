import { PRACTICE_PREFIX, isPracticeAccount } from "@/lib/brokers/topstep/account-classification";

// Re-export so the barrel can pull predicate helpers from one place.
export { PRACTICE_PREFIX, isPracticeAccount };

export const PRACTICE_ONLY_KEY = "trading_practice_only";
// Per-mode selection so flipping practice on/off doesn't lose the prior
// pick in either bucket.
export const SELECTED_ACCOUNT_KEY_PRACTICE = "trading_selected_account_id_practice";
export const SELECTED_ACCOUNT_KEY_LIVE = "trading_selected_account_id_live";

/**
 * Superseded key names, oldest first. These are **container** keys, not
 * credentials — `topstep_username`, `topstep_api_key`, `topstep_webhook_url`
 * and `topstep_creds_validated_*` live in `db/settings.ts` /
 * `db/cred-validation.ts`, name a real Topstep credential, and are
 * correctly named. Do not sweep those.
 *
 * Two generations exist because the per-mode split (gen 1) already
 * superseded a single selection key (gen 0), and the container rename
 * supersedes both. Every one of these is a setting an operator chose, so
 * each is adopted rather than dropped.
 */
const LEGACY_SELECTED_ACCOUNT_KEY = "topstep_selected_account_id";
const LEGACY_SELECTED_ACCOUNT_KEY_PRACTICE = "topstep_selected_account_id_practice";
const LEGACY_SELECTED_ACCOUNT_KEY_LIVE = "topstep_selected_account_id_live";
const LEGACY_PRACTICE_ONLY_KEY = "topstep_practice_only";

export function selectionKey(practiceOnly: boolean): string {
  return practiceOnly ? SELECTED_ACCOUNT_KEY_PRACTICE : SELECTED_ACCOUNT_KEY_LIVE;
}

/** Move one key's value to its successor, unless the successor already
 *  holds a value — a newer choice always wins over an older one. The
 *  legacy key is dropped either way so the migration converges. */
function adoptKey(from: string, to: string): void {
  const value = localStorage.getItem(from);
  if (value == null) return;
  if (localStorage.getItem(to) == null) localStorage.setItem(to, value);
  localStorage.removeItem(from);
}

/**
 * Adopt every superseded storage key into its current name. Idempotent,
 * and safe to call from any read path — which is what the read helpers
 * below do, so an operator never has to hit a specific screen for their
 * settings to survive.
 *
 * Order is load-bearing: gen 1 is adopted before gen 0, so an operator
 * who has both keeps the per-mode choice they made most recently rather
 * than having it overwritten by the pre-split single selection.
 */
export function migrateLegacyStorageKeys(): void {
  if (typeof window === "undefined") return;

  adoptKey(LEGACY_PRACTICE_ONLY_KEY, PRACTICE_ONLY_KEY);
  adoptKey(LEGACY_SELECTED_ACCOUNT_KEY_PRACTICE, SELECTED_ACCOUNT_KEY_PRACTICE);
  adoptKey(LEGACY_SELECTED_ACCOUNT_KEY_LIVE, SELECTED_ACCOUNT_KEY_LIVE);

  // Gen 0 predates the per-mode split, so it seeds both buckets.
  const legacy = localStorage.getItem(LEGACY_SELECTED_ACCOUNT_KEY);
  if (legacy == null) return;
  if (localStorage.getItem(SELECTED_ACCOUNT_KEY_PRACTICE) == null) {
    localStorage.setItem(SELECTED_ACCOUNT_KEY_PRACTICE, legacy);
  }
  if (localStorage.getItem(SELECTED_ACCOUNT_KEY_LIVE) == null) {
    localStorage.setItem(SELECTED_ACCOUNT_KEY_LIVE, legacy);
  }
  localStorage.removeItem(LEGACY_SELECTED_ACCOUNT_KEY);
}

/** Best-effort prior selection for the reducer's ACCOUNTS_LOADED path,
 *  which doesn't know `practiceOnly` yet. Returns the first stored value
 *  that matches a loaded account (either bucket). The practice-aware
 *  fallback effect re-selects to the correct bucket on next render. */
export function readAnyStoredAccountId(): number | null {
  if (typeof window === "undefined") return null;
  migrateLegacyStorageKeys();
  for (const key of [SELECTED_ACCOUNT_KEY_PRACTICE, SELECTED_ACCOUNT_KEY_LIVE]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Read the stored selection for the active mode (practice on or off). */
export function readStoredAccountIdFor(practiceOnly: boolean): number | null {
  if (typeof window === "undefined") return null;
  migrateLegacyStorageKeys();
  const raw = localStorage.getItem(selectionKey(practiceOnly));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Read the persisted practice-only toggle. `null` means the operator has
 *  never set it. Migrates first, so an install carrying the old key reads
 *  its own value rather than defaulting. */
export function readStoredPracticeOnly(): boolean | null {
  if (typeof window === "undefined") return null;
  migrateLegacyStorageKeys();
  const raw = localStorage.getItem(PRACTICE_ONLY_KEY);
  if (raw == null) return null;
  return raw === "true";
}
