/**
 * Process-global stash for the boot-time session-migration runner's
 * `blocked` list — the deployments that couldn't be migrated because
 * they hold open broker positions. The Active-tab banner reads this via
 * `/api/deployments/migration-status` so the trader knows which rows
 * to flatten before the next engine restart completes the migration.
 *
 * Process-global by design: one engine per process, the runner fires
 * once at boot, and the value is read-mostly by the banner.
 */

let blockedIds: ReadonlySet<string> = new Set();

export function setMigrationBlocked(ids: ReadonlyArray<string>): void {
  blockedIds = new Set(ids);
}

export function getMigrationBlocked(): ReadonlySet<string> {
  return blockedIds;
}
