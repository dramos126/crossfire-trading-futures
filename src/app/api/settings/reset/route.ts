import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/connection";
import { clearCachedToken, clearSession } from "@/lib/db/auth";
import { clearWebAccount } from "@/lib/db/web-account";
import { invalidateSettingsCache } from "@/lib/db/settings-cache";
import { CRED_VALIDATION_KEYS } from "@/lib/db/cred-validation";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

/**
 * Phase 6b destructive reset. Authenticated — only an operator with a
 * working session can wipe (the symmetric inverse of /api/settings/setup,
 * which is unauthenticated and only callable when no creds exist).
 *
 * Factory-reset semantics: hard-delete deployments, tombstones, trades,
 * and bar snapshots in addition to the credential/setup app_settings keys
 * + auth_token. No archive flag, no soft state.
 *
 * Order is load-bearing:
 *  1. Wipe app_settings rows + deployments + trades + app sessions inside
 *     one txn
 *  2. invalidateSettingsCache()  (BEFORE token cache clear)
 *  3. clearCachedToken()         (AFTER settings cache clear)
 * A parallel /api/auth landing between steps 2 and 3 re-reads the wiped
 * DB, finds no credentials, and returns 503/needsSetup. Correct. The
 * reverse order would leave the settings cache still holding the deleted
 * credentials, so that request would pass `isConfigured()`, mint a token
 * against them, and write it back after the wipe.
 *
 * Open broker positions are NOT force-flattened — the engine drops to
 * passive-no-creds at the next /api/auth tick which prevents new entries,
 * but existing positions stay where they are at the broker. The operator
 * uses the broker UI to flatten if needed.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Confirmation required" }, { status: 400 });
  }
  const input = body as { confirm?: unknown };
  if (input.confirm !== "RESET") {
    return NextResponse.json({ error: "Confirmation required" }, { status: 400 });
  }

  try {
    getDb().transaction(() => {
      // App-settings: drop the five 6b Topstep/setup keys + the seven
      // Tradovate cred keys (Phase 1) + the Databento API key + the
      // per-member cred-validation keys (sourced from CRED_VALIDATION_KEYS
      // so adding a new validation key in cred-validation.ts can't
      // silently leak across a reset).
      // notifications_enabled is intentionally preserved — it's a UI
      // preference, not a credential, and survives a factory reset. The
      // market_data_* provider selections are preserved for the same
      // reason: they are configuration, and both default to Topstep, so a
      // never-touched install is unaffected either way.
      const baseKeys = [
        'topstep_username', 'topstep_api_key', 'topstep_webhook_url',
        'setup_confirmed_at', 'setup_confirmed_signature',
        'tradovate_username', 'tradovate_password', 'tradovate_api_cid',
        'tradovate_api_secret', 'tradovate_app_id', 'tradovate_app_version',
        'tradovate_device_id', 'tradovate_device_id_user_set',
        'databento_api_key', 'databento_probe_range',
      ];
      const allKeys = [...baseKeys, ...CRED_VALIDATION_KEYS];
      const placeholders = allKeys.map(() => '?').join(', ');
      getDb()
        .prepare(`DELETE FROM app_settings WHERE key IN (${placeholders})`)
        .run(...allKeys);
      // Deployments + trades + bars. trade_bars CASCADEs on trades via
      // its FK so we don't have to touch it explicitly. deployment_groups
      // is dropped too — orphan groups serve no purpose post-reset.
      // account_brokers: Phase 4 per-account broker tags. Reset wipes
      // them so a re-setup under different creds doesn't carry forward
      // a stale Tradovate→Topstep mapping. Repopulated automatically on
      // the first registry refresh after reset.
      getDb().prepare(`DELETE FROM strategy_trades`).run();
      getDb().prepare(`DELETE FROM deployments`).run();
      try { getDb().prepare(`DELETE FROM deployment_groups`).run(); } catch { /* table may not exist on old DBs */ }
      try { getDb().prepare(`DELETE FROM account_brokers`).run(); } catch { /* table may not exist on old DBs */ }
      // The credentials that authenticated every outstanding app session
      // are gone, so the sessions go with them — inside the wipe, so a
      // failed reset cannot leave live sessions pointing at half-deleted
      // state. The caller's own session dies here too, which is correct:
      // the wizard it redirects to is unauthenticated.
      //
      // The sign-in account goes too: a reset install's first run asks for
      // a new one, and the setup route stays closed while one exists.
      clearWebAccount();
      clearSession();
    })();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      { status: 500 },
    );
  }

  // A wipe is a mutation of the deployment set, and the emit rule's unit is
  // the mutation. Below the transaction, so a listener's refetch cannot read
  // rows one statement from being deleted.
  //
  // The rationale this replaces claimed the event was unnecessary because
  // the wipe kills every stream and the setup guard redirects. Neither holds:
  // `/api/engine/stream` validates the session once at connect and never per
  // frame, `engine.stop()` never touches `broadcaster.listeners`, and
  // `SetupGuard` redirects on a status only `connect()` writes — which an
  // already-mounted second tab does not re-run. That tab renders deployments
  // deleted from SQLite, indefinitely.
  //
  // **The emit is necessary and not sufficient, and the residue is recorded
  // rather than papered over**: `clearSession()` ran inside the same wipe, so
  // the refetch this provokes answers 401 and the store keeps its last
  // snapshot. What closes the gap is a tab whose session is refused
  // returning to `disconnected` — an app-wide change to the provider's status
  // machine, filed in docs/bugs.md, not a second special case here.
  //
  // The trade wipe above sends no `tradesChanged`, deliberately: with every
  // session gone a tab's trade refetch answers 401 too, and this frame's
  // refused refetch is what signs the tab out and drops its trade views.
  await handle.emitDeploymentsChanged();
  // Settings cache first: the reverse order lets a concurrent /api/auth
  // mint a token under the credentials this reset just deleted.
  invalidateSettingsCache();
  clearCachedToken();
  // Stop the engine immediately so in-memory deployments don't keep firing
  // after the DB wipe. Without this the engine ticks against stale state
  // until the next /api/auth passive-no-creds detection (~10s).
  await handle.stopIfRunning();
  await handle.invalidateAccountNames();

  return NextResponse.json({ ok: true });
}
