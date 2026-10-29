import { createHash, timingSafeEqual } from "node:crypto";
import { appRole, EngineNotInThisProcessError, readInternalSecret } from "@/lib/role";
import type { EngineCallAnswer } from "@/lib/trading/engine/handle/remote";

/**
 * The gate on the engine process's internal endpoint. **Not the app
 * session**, by design: the caller is a `web` process, not a browser, and
 * it authenticates with the shared secret both roles read from
 * `CROSSFIRE_INTERNAL_SECRET` — never the user's session or password, so
 * neither a stolen session nor the sign-in can drive the engine directly.
 * Served by the `engine` role alone: in `all` there is no second process to
 * call it, and in `web` the engine it would dispatch to is not here.
 */

export const NOT_SERVED = "EngineEndpointNotServed";
export const UNAUTHORIZED = "EngineEndpointUnauthorized";
export const SECRET_MISSING = "InternalSecretMissing";
export const UNKNOWN_METHOD = "UnknownEngineMethod";
export const BAD_REQUEST = "BadEngineRequest";
export const BODY_TOO_LARGE = "EngineRequestTooLarge";
export const STOP_WHILE_CLOSING = "EngineStopWhileClosing";

const STATUS_NOT_FOUND = 404;
const STATUS_UNAUTHORIZED = 401;
const STATUS_SERVER_ERROR = 500;
const STATUS_UNAVAILABLE = 503;
const BEARER = "Bearer ";

export function errorAnswer(status: number, name: string, message: string): Response {
  const body: EngineCallAnswer = { ok: false, error: { name, message } };
  return Response.json(body, { status });
}

/**
 * A thrown error as the routes would have met it: an engine that is not in
 * this process (no lease) is 503, as `/api/engine/stream` answers an engine
 * it cannot build; anything else is 500, which every handle route answers.
 */
export function thrownAnswer(err: unknown): Response {
  const status = err instanceof EngineNotInThisProcessError ? STATUS_UNAVAILABLE : STATUS_SERVER_ERROR;
  if (err instanceof Error) return errorAnswer(status, err.name, err.message);
  return errorAnswer(status, "Error", String(err));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The refusal for a request this process does not serve or is not
 *  authorised for, or null to proceed. */
export function refuseInternalRequest(req: Request): Response | null {
  if (appRole() !== "engine") {
    return errorAnswer(STATUS_NOT_FOUND, NOT_SERVED, "the internal engine endpoint is served by CROSSFIRE_ROLE=engine only");
  }
  // Boot refuses this process already (instrumentation.ts); this is the
  // backstop for a request that arrives anyway.
  const { secret, problem } = readInternalSecret();
  if (secret === null) {
    return errorAnswer(STATUS_SERVER_ERROR, SECRET_MISSING, `${problem} on the engine process`);
  }
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith(BEARER) ? header.slice(BEARER.length) : "";
  // Compared as digests so the compare is constant-time whatever the length.
  if (!presented || !timingSafeEqual(digest(presented), digest(secret))) {
    return errorAnswer(STATUS_UNAUTHORIZED, UNAUTHORIZED, "missing or wrong internal secret");
  }
  return null;
}
