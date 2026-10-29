/**
 * The playbooks a production build registers. Which ones, and when each was
 * promoted and why, is the operator's record in
 * `docs/modules/trading/deployments-books-history.md`; the first rule was the
 * operator's of 2026-10-12: "anything not in it I want it out of prod for now".
 *
 * **The `prod/` folder is the mechanism; this list is the statement boot
 * checks against, and `registry.test.ts` keeps the two equal.** `index.ts`'s
 * every-build context reads `prod/` and nothing else, so promoting a playbook
 * is moving its folder there and adding its key here, in one commit — either
 * alone fails that test.
 *
 * A key is the module's filename, not its directory, and each one here is the
 * slug of its module's `config.name` (`registry.test.ts`). The keys these
 * replaced on 2026-10-16 are in `renamed-keys.ts`.
 */
export const PROD_PLAYBOOK_KEYS: readonly string[] = ["bar-close-pulse", "ema-crossover", "trend-follower"];

/**
 * How a build's registry differs from the list, or null when it does not.
 * `missing` is checked in every environment — every build registers `prod/`,
 * so a listed key it lacks is a renamed, moved or deleted module. `unlisted`
 * only on prod, where nothing but the list may register. Boot reports a non-null
 * answer as `boot_playbooks_mismatch`; `registry.test.ts` is the build-time
 * half.
 */
export function prodRegistryMismatch(
  registered: readonly string[],
  prod: boolean,
): { missing: string[]; unlisted: string[] } | null {
  const have = new Set(registered);
  const listed = new Set(PROD_PLAYBOOK_KEYS);
  const missing = PROD_PLAYBOOK_KEYS.filter((k) => !have.has(k));
  const unlisted = prod ? registered.filter((k) => !listed.has(k)) : [];
  return missing.length === 0 && unlisted.length === 0 ? null : { missing, unlisted };
}

/**
 * What a row whose playbook this build does not register may do, said once for
 * every surface that meets one: the board's status chip, the book grid's cell,
 * the engine's activation line and the deployment editor. ui/copy.md rule 4 —
 * one sentence, passed through verbatim.
 *
 * It names the platform's capability rather than the reason the module is
 * missing (staging-only today; a renamed or deleted module reads the same),
 * and it says the history is kept because "not in this build" otherwise reads
 * as "deleted".
 */
export const PLAYBOOK_NOT_IN_BUILD =
  "This playbook is not part of this build of the platform, so it takes no entries and " +
  "nothing manages a position it holds. Its settings and trade history are kept.";
