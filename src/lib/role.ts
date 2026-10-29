/**
 * Which half of the app this process runs: `CROSSFIRE_ROLE=all | web | engine`,
 * default `all` — today's single process, and what the public compose file
 * runs. See docs/proposals/zero-downtime-deploys.md, step 2.
 *
 * Read on every call rather than cached, so there is no stale copy to
 * disagree with the environment; an unknown value throws on whichever read
 * comes first, which is the database's first open.
 */

export type AppRole = "all" | "web" | "engine";

const ROLES: readonly AppRole[] = ["all", "web", "engine"];
const ROLE_ENV = "CROSSFIRE_ROLE";
const DEFAULT_ROLE: AppRole = "all";

function isAppRole(value: string): value is AppRole {
  return (ROLES as readonly string[]).includes(value);
}

export function appRole(): AppRole {
  const raw = process.env[ROLE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_ROLE;
  if (isAppRole(raw)) return raw;
  throw new Error(`${ROLE_ENV}="${raw}" is not a role — use one of ${ROLES.join(", ")}`);
}

/** This process may build and run an engine, and owns the database's schema. */
export function runsEngine(): boolean {
  return appRole() !== "web";
}

/** This process serves the UI and the API routes. */
export function servesWeb(): boolean {
  return appRole() !== "engine";
}

const STANDBY_ENV = "CROSSFIRE_STANDBY";
const STANDBY_ON = "1";

/**
 * `CROSSFIRE_STANDBY=1`: this `engine` process was started beside a running
 * engine to take it over (engine-boot.md, *Hand-off*). A flag the deploy sets
 * on the container it starts, rather than something boot infers from a held
 * lease: an engine container started by mistake beside a live one must
 * refuse, as it always has, not take the engine over.
 */
export function bootsAsStandby(): boolean {
  return process.env[STANDBY_ENV] === STANDBY_ON;
}

export const INTERNAL_SECRET_ENV = "CROSSFIRE_INTERNAL_SECRET";

/** A guessable secret is the whole of the engine endpoint's protection if
 *  its port is ever reachable, so a short one is refused, not warned about. */
export const INTERNAL_SECRET_MIN_LENGTH = 32;

export type InternalSecretRead = { secret: string; problem: null } | { secret: null; problem: string };

/**
 * The shared secret a `web` process sends the `engine` process's internal
 * endpoint, trimmed — or the sentence saying why there is none usable: unset,
 * blank, or shorter than {@link INTERNAL_SECRET_MIN_LENGTH} once trimmed.
 * Never the user's credential: a secret either role reads from its
 * environment, so a leaked session or password cannot drive the engine and
 * the engine never learns either.
 */
export function readInternalSecret(): InternalSecretRead {
  const secret = (process.env[INTERNAL_SECRET_ENV] ?? "").trim();
  if (secret === "") return { secret: null, problem: `${INTERNAL_SECRET_ENV} is not set` };
  if (secret.length < INTERNAL_SECRET_MIN_LENGTH) {
    return {
      secret: null,
      problem: `${INTERNAL_SECRET_ENV} is ${secret.length} characters once trimmed; it needs at least ${INTERNAL_SECRET_MIN_LENGTH}`,
    };
  }
  return { secret, problem: null };
}

/**
 * Thrown where a `web` process reaches for the engine. Typed so the engine
 * handle can translate it into a call to the engine process once that
 * exists; until then it propagates.
 */
export class EngineNotInThisProcessError extends Error {
  constructor(
    readonly door: string,
    why = `this process runs as ${ROLE_ENV}=web and never builds an engine`,
  ) {
    super(`${door}: ${why}`);
    this.name = "EngineNotInThisProcessError";
  }
}
