import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getTradovateAppId,
  getTradovateAppVersion,
  getTradovateDeviceId,
  getTradovateDeviceIdUserSet,
  setTradovateAppId,
  setTradovateAppVersion,
  setTradovateDeviceId,
  setTradovateDeviceIdUserSet,
} from "@/lib/db/settings";

/**
 * Pre-fill helpers for the three Tradovate fields the operator shouldn't
 * have to think about. Account-specific fields (username/password/apiCid/
 * apiSecret) stay null until typed; the bundle here only fills the
 * app-identity / install-identity trio.
 *
 * Server-side only — these helpers read package.json and the app DB; they
 * must not be imported into client components.
 */

const APP_ID_DEFAULT = "TopstepAPI";

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
    console.warn("[tradovate-defaults] package.json version missing — falling back to 0.0.0");
    cachedVersion = "0.0.0";
    return cachedVersion;
  } catch (err) {
    console.warn("[tradovate-defaults] failed to read package.json — falling back to 0.0.0", err);
    cachedVersion = "0.0.0";
    return cachedVersion;
  }
}

export interface TradovateAppIdentityResolved {
  appId: string;
  appVersion: string;
  deviceId: string;
  /**
   * True when the persisted (or unset) value still matches the default the
   * server would have served — i.e. the operator hasn't customized it.
   * Flips false the moment the persisted value diverges from the default.
   */
  appIdAuto: boolean;
  appVersionAuto: boolean;
  /**
   * True when the operator hasn't explicitly overridden the auto-generated
   * UUID. deviceId is random per install so we can't compare to a constant
   * default — the wizard/Settings save handler sets the
   * `tradovate_device_id_user_set` flag to true when the operator submits
   * a value that differs from the persisted UUID. Clearing the field and
   * saving wipes both the UUID and the flag, so the next preload generates
   * a fresh UUID and the badge returns.
   * Critical: deviceId rotation triggers fresh device-binding on Tradovate's
   * side, so we never auto-regenerate once a value is on disk.
   */
  deviceIdAuto: boolean;
}

/**
 * Resolve the three app-identity / install-identity fields, filling in
 * defaults for any that are unset. All three paths WRITE on first
 * resolution (persist-on-generate) so subsequent calls return the same
 * values and `readTradovateCredentialsFromDb()` finds the full 7-field
 * bundle on disk. Without persisting appId/appVersion, the settings PUT
 * path (which only writes dirty fields) would leave them null in DB and
 * the Tradovate fan-out would be skipped.
 *
 * Idempotent on subsequent calls once the DB has all three — no write.
 */
export function resolveTradovateAppIdentity(): TradovateAppIdentityResolved {
  const dbAppId = getTradovateAppId();
  const dbAppVersion = getTradovateAppVersion();
  const dbDeviceId = getTradovateDeviceId();

  let appId: string;
  if (dbAppId !== null) {
    appId = dbAppId;
  } else {
    appId = APP_ID_DEFAULT;
    setTradovateAppId(APP_ID_DEFAULT);
  }
  const appIdAuto = appId === APP_ID_DEFAULT;

  const versionDefault = readPackageVersion();
  let appVersion: string;
  if (dbAppVersion !== null) {
    appVersion = dbAppVersion;
  } else {
    appVersion = versionDefault;
    setTradovateAppVersion(versionDefault);
  }
  const appVersionAuto = appVersion === versionDefault;

  let deviceId: string;
  if (dbDeviceId !== null && dbDeviceId.trim().length > 0) {
    deviceId = dbDeviceId;
  } else {
    deviceId = randomUUID();
    setTradovateDeviceId(deviceId);
    // Fresh generate — operator hasn't touched it yet.
    setTradovateDeviceIdUserSet(false);
  }
  const deviceIdAuto = !getTradovateDeviceIdUserSet();

  return { appId, appVersion, deviceId, appIdAuto, appVersionAuto, deviceIdAuto };
}

/**
 * Test-only helper to clear the in-memory package.json version cache.
 * Not used in production paths.
 */
export function __resetTradovateAppIdentityCacheForTests(): void {
  cachedVersion = null;
}
