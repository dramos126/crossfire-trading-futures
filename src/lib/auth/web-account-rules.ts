/**
 * What a sign-in name and password must be. A leaf with no imports, because
 * the first-run form and Settings' *Change password* check the same rules in
 * the browser before the server checks them again.
 *
 * Length is the only password rule. A long passphrase beats a short password
 * with a digit and a symbol forced into it, and composition rules push people
 * toward the second (NIST SP 800-63B and OWASP both say the same).
 */

export const USERNAME_MIN_CHARS = 3;
export const USERNAME_MAX_CHARS = 64;
export const PASSWORD_MIN_CHARS = 12;
/** Not a strength rule: it bounds what one sign-in can ask the slow hash to
 *  chew through. */
export const PASSWORD_MAX_CHARS = 1024;

export const USERNAME_LENGTH_PROBLEM = `Username must be ${USERNAME_MIN_CHARS} to ${USERNAME_MAX_CHARS} characters.`;
export const PASSWORD_TOO_SHORT_PROBLEM = `Password must be at least ${PASSWORD_MIN_CHARS} characters.`;
export const PASSWORD_TOO_LONG_PROBLEM = `Password must be at most ${PASSWORD_MAX_CHARS} characters.`;
export const PASSWORDS_DIFFER_PROBLEM = "The two passwords do not match.";

/** Characters as a person counts them, not UTF-16 code units. */
function charCount(value: string): number {
  return Array.from(value).length;
}

export function usernameProblem(username: string): string | null {
  const n = charCount(username);
  return n < USERNAME_MIN_CHARS || n > USERNAME_MAX_CHARS ? USERNAME_LENGTH_PROBLEM : null;
}

/** Over the cap, so it cannot be the stored password and is refused before
 *  the slow hash runs. */
export function passwordTooLong(password: string): boolean {
  return charCount(password) > PASSWORD_MAX_CHARS;
}

export function passwordProblem(password: string): string | null {
  const n = charCount(password);
  if (n < PASSWORD_MIN_CHARS) return PASSWORD_TOO_SHORT_PROBLEM;
  if (n > PASSWORD_MAX_CHARS) return PASSWORD_TOO_LONG_PROBLEM;
  return null;
}
