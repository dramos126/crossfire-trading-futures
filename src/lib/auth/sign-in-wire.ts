/**
 * What `POST /api/auth` answers, shared by the route and the browser so the
 * two cannot drift. A leaf: the browser imports it.
 */

/** One body for a wrong username and a wrong password alike, so the answer
 *  never says which half was right. */
export const INVALID_SIGN_IN_MESSAGE = "Wrong username or password.";

export const SIGN_IN_REQUIRED_MESSAGE = "Sign in required.";

export const RATE_LIMITED_MESSAGE = "Too many failed sign-ins.";

export const VERIFY_BUSY_MESSAGE = "Another sign-in is being checked.";

/** Which lock a 429 is about, carried as `lockout` so the sentence can say
 *  whose lockout it is: this address's, every address's, or no lockout at
 *  all — one password check runs at a time and another was running. */
export type RateLimitScope = "address" | "server" | "busy";

export const WRONG_CURRENT_PASSWORD_MESSAGE = "The current password is wrong.";

/** An upgraded install's first run (a broker, no account) asks for the code
 *  the server printed to its own output; `setup-code.ts` says why. */
export const SETUP_CODE_HINT =
  "Printed in the server's log on a line that begins ACCOUNT SETUP CODE. Read it with docker compose logs where Crossfire runs; if there are several, use the last.";
export const SETUP_CODE_MISSING_MESSAGE = "Enter the setup code from the server's log.";
export const SETUP_CODE_WRONG_MESSAGE = "That is not the setup code in the server's log.";

/** The 200 body:the session itself is in the cookie, never in the body. */
export interface SignedInBody {
  signedIn: true;
  engineReady: boolean;
}
