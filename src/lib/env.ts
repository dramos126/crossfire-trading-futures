/**
 * Env-var gates. Single source of truth so callers don't read
 * `process.env.*` directly and drift on the parsing rule.
 *
 * Keep additions narrow: each helper should return a primitive (boolean
 * or string) the caller can branch on without re-parsing.
 *
 * Most helpers here are server-only — server gates do NOT use the
 * `NEXT_PUBLIC_` prefix and UI gating for those concerns happens via
 * API responses, not by exposing env to the client bundle. The
 * `isProductionEnv` / `isStagingEnv` pair is the exception: those read
 * `NEXT_PUBLIC_APP_ENV` because the chrome (top nav, status rail) and
 * the practice-only lock in the client hook need to render
 * synchronously at build time without a server round-trip. Inlined by
 * `next build` from the Dockerfile's ARG APP_ENV — flipping at runtime
 * has no effect until rebuild.
 */

/**
 * Deploy-environment gates. The canonical literal is `"prod"` — matches
 * the Dockerfile's `APP_ENV` build arg. Anything
 * else (including `"staging"`, `"production"`, undefined, or a typo) is
 * non-prod / staging. Two predicates so call sites read clearly at the
 * branch.
 *
 * Drives:
 *   - Tradovate API/WS host selection (prod → live, staging → demo).
 *     Tradovate's live/demo split is host-level; the per-account
 *     `practice` flag the translator stamps for `isPracticeAccount`
 *     reads `isStagingEnv()` to mark a Tradovate account practice
 *     when the install is pointed at the demo gateway.
 *   - Which accounts may be auto-traded: `autoTradeVerdict` narrows to
 *     practice accounts only on staging, per broker. The highest-
 *     consequence reader of this pair, and the reason the polarity
 *     below is a safety property rather than a convenience.
 *   - Staging-only behaviors: PRAC allowlist boot derivation, the
 *     practice-only lock in `useTradingState`, the amber non-prod
 *     chrome on top-nav + status-rail, the staging-only strategies/
 *     test/ subtree gate.
 *
 * Inlined by `next build` from `NEXT_PUBLIC_APP_ENV`; flipping at
 * runtime has no effect until rebuild.
 */
export function isProductionEnv(): boolean {
  return process.env.NEXT_PUBLIC_APP_ENV === "prod";
}

export function isStagingEnv(): boolean {
  return !isProductionEnv();
}
