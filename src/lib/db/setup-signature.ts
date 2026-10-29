import { createHash } from "node:crypto";

/**
 * Phase 6b confirmation signature — a non-secret hash of the
 * configuration inputs the wizard last confirmed. Used by <SetupGuard>
 * to detect out-of-band rotations (operator swapped the env API key
 * during a redeploy without re-running the wizard) so it can re-prompt
 * for confirmation.
 *
 * Inputs per the punchlist + plan §3:
 *   - username (DB or env, whichever resolves)
 *   - has_db_key (boolean)
 *   - has_env_key (boolean)
 *   - webhook URL (DB-first, then env, normalized to "")
 *
 * The API key value itself is NEVER included — both for security
 * (the signature is stored in plaintext SQL, sent over the network) and
 * because including it would defeat the "skip wizard on env-only setups"
 * happy path: every redeploy that restores the same env would compute
 * the same hash without exposing anything.
 */
export interface SignatureInput {
  username: string | null;
  hasDbKey: boolean;
  hasEnvKey: boolean;
  webhookUrl: string | null;
}

export function computeConfigSignature(input: SignatureInput): string {
  const normalized = JSON.stringify({
    u: input.username ?? "",
    db: input.hasDbKey ? 1 : 0,
    env: input.hasEnvKey ? 1 : 0,
    w: input.webhookUrl ?? "",
  });
  return createHash("sha256").update(normalized).digest("hex");
}
