/**
 * Every playbook key that was renamed, old → new — the one list the stored-row
 * migration in `db/deployments.ts` reads.
 *
 * A map rather than a `formerKeys` field on the module config because the
 * migration cannot load the registry (`require.context` exists only in the
 * bundler), and because a variant that spreads its parent's config (an MES
 * port of an MNQ playbook) would inherit the parent's former keys. An old key
 * is never an alias: nothing resolves it.
 */
export const RENAMED_KEYS: Readonly<Record<string, string>> = {};
