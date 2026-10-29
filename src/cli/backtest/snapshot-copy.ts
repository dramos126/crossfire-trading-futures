/**
 * The trading-database snapshot, as `parity-day` and `book` read it: the
 * file `TRADING_DB_PATH` names, opened read-only once and copied through
 * SQLite's backup API into a private temp file, from which every credential
 * and token is deleted. Everything after reads the copy, so the snapshot
 * file is never written and no credential outlives the run.
 */
import { existsSync, statSync } from "node:fs";

import Database from "better-sqlite3";

import { CliError } from "./cli-error";
import { DB_PATH_VAR } from "./topstep-tail";

const SNAPSHOT_META_TABLE = "snapshot_meta";

/**
 * Removed from the private copy so the tail authenticates with the
 * environment's credentials, whatever the snapshot carried, and so no
 * credential or session survives in a file this process writes. Keep it in
 * step with the database-copy scrub's full list.
 */
const CREDENTIAL_SETTING_KEYS = [
  "topstep_api_key", "topstep_username", "topstep_webhook_url",
  "tradovate_username", "tradovate_password", "tradovate_api_secret", "tradovate_api_cid",
  "tradovate_app_id", "tradovate_app_version", "tradovate_device_id", "tradovate_device_id_user_set",
  "databento_api_key", "databento_probe_range",
  "setup_confirmed_at", "setup_confirmed_signature",
  "topstep_creds_validated_signature", "topstep_creds_validated_at",
  "tradovate_creds_validated_signature", "tradovate_creds_validated_at",
  "databento_creds_validated_signature", "databento_creds_validated_at",
];
/** The cached broker JWT, the legacy engine one, and the app's sessions. */
const TOKEN_TABLES = ["auth_token", "engine_auth_token", "app_session"];

/** The snapshot's path, or a refusal naming the variable. */
export function requireDatabase(command: string): string {
  const file = process.env[DB_PATH_VAR];
  if (file == null || file.length === 0) {
    throw new CliError(`${DB_PATH_VAR} is not set; ${command} reads the trading database snapshot.`);
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new CliError(`${DB_PATH_VAR} points at ${file}, which is not a file. Nothing was recorded.`);
  }
  return file;
}

export function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) != null
  );
}

/** `snapshot_meta.taken_at` as written; null on a copy older than the table. */
export function readTakenAt(db: Database.Database): string | null {
  if (!hasTable(db, SNAPSHOT_META_TABLE)) return null;
  const row = db.prepare(`SELECT taken_at FROM ${SNAPSHOT_META_TABLE} LIMIT 1`).get() as
    | { taken_at: unknown }
    | undefined;
  // A table with no usable row is not a copy older than the table; judged as
  // an unreadable instant, it refuses.
  return typeof row?.taken_at === "string" ? row.taken_at : String(row?.taken_at ?? "");
}

/** One consistent copy (a WAL beside the source is included), then scrubbed. */
export async function copyAndScrub(source: Database.Database, copyPath: string): Promise<void> {
  await source.backup(copyPath);
  const copy = new Database(copyPath);
  try {
    if (!hasTable(copy, "app_settings")) {
      throw new CliError(`${copyPath} has no app_settings table; it is not a trading database snapshot.`);
    }
    // A plain DELETE only unlinks the row; its bytes stay in the freed page.
    copy.pragma("secure_delete = ON");
    copy
      .prepare(`DELETE FROM app_settings WHERE key IN (${CREDENTIAL_SETTING_KEYS.map(() => "?").join(", ")})`)
      .run(...CREDENTIAL_SETTING_KEYS);
    for (const table of TOKEN_TABLES) {
      if (hasTable(copy, table)) copy.prepare(`DELETE FROM ${table}`).run();
    }
  } finally {
    copy.close();
  }
}
