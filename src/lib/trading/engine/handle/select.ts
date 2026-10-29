import { readInternalSecret, runsEngine } from "@/lib/role";
import type { EngineHandle } from "@/lib/trading/engine/handle";
import { localEngineHandle } from "@/lib/trading/engine/handle/local";
import { EngineRemoteError, EngineUnreachableError, remoteEngineHandle } from "@/lib/trading/engine/handle/remote";

export const ENGINE_URL_ENV = "CROSSFIRE_ENGINE_URL";

/**
 * Chosen once per process and parked on `globalThis`: the remote handle holds
 * the process's one upstream event stream, and route graphs that each loaded
 * this module must share it rather than open one apiece.
 */
const HANDLE_KEY = "__crossfireEngineHandle";
type GlobalWithHandle = typeof globalThis & { [HANDLE_KEY]?: EngineHandle };

const HTTP_PROTOCOLS = ["http:", "https:"];

function isHttpUrl(value: string): boolean {
  try {
    return HTTP_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function chooseEngineHandle(): EngineHandle {
  if (runsEngine()) return localEngineHandle();
  const url = process.env[ENGINE_URL_ENV];
  if (!url) {
    throw new Error(`${ENGINE_URL_ENV} is not set: a CROSSFIRE_ROLE=web process reaches the engine process at that URL`);
  }
  // The value is not echoed: a URL can carry `user:pass@`, and this reaches logs.
  if (!isHttpUrl(url)) throw new Error(`${ENGINE_URL_ENV} is not an http(s) URL`);
  const { secret, problem } = readInternalSecret();
  if (secret === null) {
    throw new Error(`${problem}: a CROSSFIRE_ROLE=web process authenticates to the engine process with it`);
  }
  return remoteEngineHandle(url, secret);
}

/** The engine in this process (`all`, `engine`), or the engine process over
 *  HTTP (`web`). A misconfigured `web` process throws here, at first use, and
 *  on every use after until it is fixed — nothing is cached from a throw. */
export function engineHandle(): EngineHandle {
  const g = globalThis as GlobalWithHandle;
  return (g[HANDLE_KEY] ??= chooseEngineHandle());
}

/** What a route answers when the engine process gave no answer. */
export const ENGINE_UNREACHABLE_STATUS = 503;

/** The engine process gave no answer, a timeout included — only the remote
 *  handle throws this, so in the `all` and `engine` roles it is never true. */
export function isEngineUnreachable(err: unknown): err is EngineUnreachableError {
  return err instanceof EngineUnreachableError;
}

/** The engine process answered with an error — the call threw there, or the
 *  endpoint refused it (no lease, wrong role). Only the remote handle throws
 *  this, so in the `all` and `engine` roles it is never true. */
export function isEngineRemoteError(err: unknown): err is EngineRemoteError {
  return err instanceof EngineRemoteError;
}
