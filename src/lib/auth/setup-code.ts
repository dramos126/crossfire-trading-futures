import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The proof an install upgraded from before the login asks for when it
 * creates its account. Such an install has a broker and no account, so its
 * first run is reachable by anyone who reaches the port; the code is what
 * only the person holding the server can read.
 *
 * Not a broker credential (brokers-client.md): a broker key proves the app
 * can trade, and a Tradovate-only install has no key the wizard could ask for.
 *
 * In memory, one per process until it is consumed, and printed straight to
 * stdout — **never through the log pipe**, whose lines persist in
 * `engine_logs`, reach `/logs` and can page Discord. stdout is what
 * `docker logs` and `docker compose logs` show, and nothing else.
 */

/** 16 random bytes as hex: 32 characters, nothing to mistype between. */
const SETUP_CODE_BYTES = 16;
export const SETUP_CODE_LINE_PREFIX = "ACCOUNT SETUP CODE: ";

/** On `globalThis`, not module scope: instrumentation and the route handlers
 *  can load separate module graphs, and each would mint and print its own
 *  code — the operator would read one and the route would check the other. */
const CODE_GLOBAL_KEY = "__crossfireAccountSetupCode";
type GlobalWithCode = typeof globalThis & { [CODE_GLOBAL_KEY]?: string | null };

function currentCode(): string | null {
  return (globalThis as GlobalWithCode)[CODE_GLOBAL_KEY] ?? null;
}

function setCode(value: string | null): void {
  (globalThis as GlobalWithCode)[CODE_GLOBAL_KEY] = value;
}

/** Creates and prints the code the first time it is needed; later calls are
 *  no-ops until it is consumed. Called lazily by the two first-run routes. */
export function ensureSetupCode(): void {
  if (currentCode() !== null) return;
  const code = randomBytes(SETUP_CODE_BYTES).toString("hex");
  setCode(code);
  process.stdout.write(`${SETUP_CODE_LINE_PREFIX}${code}\n`);
}

/** Constant-time over fixed-length digests, so neither the time nor the
 *  length of the candidate says anything about the code. */
export function setupCodeMatches(candidate: string): boolean {
  const code = currentCode();
  if (code === null) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(candidate.trim()), digest(code));
}

/** The account it unlocked exists; the code opens nothing more. */
export function consumeSetupCode(): void {
  setCode(null);
}

/** Test seam: the code is process-wide. */
export function resetSetupCodeForTests(): void {
  setCode(null);
}
