import { NextResponse } from "next/server";
import {
  RATE_LIMITED_MESSAGE,
  VERIFY_BUSY_MESSAGE,
  type RateLimitScope,
} from "@/lib/auth/sign-in-wire";

/**
 * Failed sign-ins, counted per key in a fixed window. `/api/auth` is the one
 * route on the box worth guessing at, so a run of wrong passwords locks the
 * key out until its window ends; a success clears it.
 *
 * **Process-local and in memory.** A restart forgets every count, and on a
 * split install only the web process sees sign-ins, so there is one counter.
 * Good enough for what it bounds — a guesser — and nothing to install.
 */

export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Across every address at once. Next keeps a client-sent `x-forwarded-for`
 * as it is when no proxy sits in front (the public compose file has none), so
 * a guesser can name a new address on every request and the per-address
 * count alone never trips. This one does — at the cost that, while it holds,
 * nobody can sign in; a browser already signed in keeps its cookie and is
 * unaffected, and *Change password* (already behind a session) does not read it.
 */
export const LOGIN_GLOBAL_FAILURE_LIMIT = 50;
const GLOBAL_KEY = "*";

/** Keys are whatever a client claims its address is, so the map is bounded:
 *  at the cap, expired windows go first, then the oldest. */
export const LOGIN_LIMITER_MAX_KEYS = 10_000;

/** The wait a request is told when another password check is running. */
export const VERIFY_BUSY_RETRY_MS = 1000;

const MS_PER_SECOND = 1000;

export type LimiterVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

interface Bucket {
  failures: number;
  windowStartMs: number;
}

export interface LoginLimiter {
  check(key: string, nowMs?: number): LimiterVerdict;
  /** True when this failure is the one that locked the key out. */
  recordFailure(key: string, nowMs?: number): boolean;
  /** Takes back one failure — a pre-counted attempt that turned out right. */
  refund(key: string): void;
  recordSuccess(key: string): void;
  size(): number;
  clear(): void;
}

export function createLoginLimiter({
  limit,
  windowMs,
  maxKeys = LOGIN_LIMITER_MAX_KEYS,
}: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): LoginLimiter {
  const buckets = new Map<string, Bucket>();

  function makeRoom(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.windowStartMs >= windowMs) buckets.delete(key);
    }
    // Insertion order is window-start order: a bucket is only ever set when
    // its window opens.
    for (const key of buckets.keys()) {
      if (buckets.size < maxKeys) break;
      buckets.delete(key);
    }
  }

  function live(key: string, nowMs: number): Bucket | null {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (nowMs - bucket.windowStartMs >= windowMs) {
      buckets.delete(key);
      return null;
    }
    return bucket;
  }

  return {
    check(key, nowMs = Date.now()) {
      const bucket = live(key, nowMs);
      if (!bucket || bucket.failures < limit) return { allowed: true };
      return { allowed: false, retryAfterMs: bucket.windowStartMs + windowMs - nowMs };
    },
    recordFailure(key, nowMs = Date.now()) {
      let bucket = live(key, nowMs);
      if (bucket === null) {
        if (buckets.size >= maxKeys) makeRoom(nowMs);
        bucket = { failures: 0, windowStartMs: nowMs };
        buckets.set(key, bucket);
      }
      bucket.failures += 1;
      return bucket.failures === limit;
    },
    refund(key) {
      const bucket = buckets.get(key);
      if (!bucket) return;
      bucket.failures -= 1;
      if (bucket.failures <= 0) buckets.delete(key);
    },
    recordSuccess(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
    clear() {
      buckets.clear();
    },
  };
}

interface LimiterState {
  perAddress: LoginLimiter;
  everyAddress: LoginLimiter;
  /** One password check at a time per process. scrypt runs on libuv's
   *  four-thread pool, which the engine's `dns.lookup` shares: a flood of
   *  parallel checks would queue every broker connect behind it. */
  verifyRunning: boolean;
}

const LIMITER_GLOBAL_KEY = "__crossfireLoginLimiter";
type GlobalWithLimiter = typeof globalThis & { [LIMITER_GLOBAL_KEY]?: LimiterState };

/** On `globalThis`, not module scope: instrumentation and the route handlers
 *  can load separate module graphs, and two copies would be two counters and
 *  two latches — each half the limit it claims to be. */
function limiterState(): LimiterState {
  const g = globalThis as GlobalWithLimiter;
  g[LIMITER_GLOBAL_KEY] ??= {
    perAddress: createLoginLimiter({ limit: LOGIN_FAILURE_LIMIT, windowMs: LOGIN_FAILURE_WINDOW_MS }),
    everyAddress: createLoginLimiter({ limit: LOGIN_GLOBAL_FAILURE_LIMIT, windowMs: LOGIN_FAILURE_WINDOW_MS }),
    verifyRunning: false,
  };
  return g[LIMITER_GLOBAL_KEY];
}

/** The address a sign-in is counted against: the first `x-forwarded-for`
 *  hop, which Next sets from the socket when nothing upstream did. */
export function clientAddress(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export interface RateLimitRefusal {
  scope: RateLimitScope;
  retryAfterMs: number;
}

export type LimitedAttempt<T> =
  | { refusal: RateLimitRefusal }
  | { refusal: null; value: T; passed: boolean; lockedOut: boolean };

/** `serverWide: false` reads and counts the address alone — for a route
 *  already behind a session, which the global lockout must not reach. */
export interface LimitedAttemptOptions {
  serverWide?: boolean;
}

function lockout(address: string, serverWide: boolean, nowMs: number): RateLimitRefusal | null {
  const { perAddress, everyAddress } = limiterState();
  const server = serverWide ? everyAddress.check(GLOBAL_KEY, nowMs) : { allowed: true as const };
  const own = perAddress.check(address, nowMs);
  if (!server.allowed) {
    const ownWait = own.allowed ? 0 : own.retryAfterMs;
    return { scope: "server", retryAfterMs: Math.max(server.retryAfterMs, ownWait) };
  }
  return own.allowed ? null : { scope: "address", retryAfterMs: own.retryAfterMs };
}

/**
 * Runs one password-style check under the limiter. The attempt is counted as
 * a failure **before** `attempt` is awaited and refunded when `passed` says it
 * was right — counted after, every request that arrived during the await had
 * already passed the check, so parallel guesses were never limited. A throw
 * leaves the failure counted.
 */
export async function limitedAttempt<T>(
  address: string,
  attempt: () => Promise<T>,
  passed: (value: T) => boolean,
  { serverWide = true }: LimitedAttemptOptions = {},
): Promise<LimitedAttempt<T>> {
  const state = limiterState();
  const { perAddress, everyAddress } = state;
  if (state.verifyRunning) return { refusal: { scope: "busy", retryAfterMs: VERIFY_BUSY_RETRY_MS } };
  const nowMs = Date.now();
  const refusal = lockout(address, serverWide, nowMs);
  if (refusal) return { refusal };

  const lockedAddress = perAddress.recordFailure(address, nowMs);
  const lockedServer = serverWide && everyAddress.recordFailure(GLOBAL_KEY, nowMs);
  state.verifyRunning = true;
  let value: T;
  try {
    value = await attempt();
  } finally {
    state.verifyRunning = false;
  }
  if (!passed(value)) return { refusal: null, value, passed: false, lockedOut: lockedAddress || lockedServer };
  // The address's count clears; the global one only takes this attempt back —
  // one right password does not forgive fifty wrong ones elsewhere.
  perAddress.recordSuccess(address);
  if (serverWide) everyAddress.refund(GLOBAL_KEY);
  return { refusal: null, value, passed: true, lockedOut: false };
}

/** The 429 every limited route answers. `Retry-After` is whole seconds. */
export function rateLimitedResponse(refusal: RateLimitRefusal): NextResponse {
  const retryAfterSeconds = Math.ceil(refusal.retryAfterMs / MS_PER_SECOND);
  const error = refusal.scope === "busy" ? VERIFY_BUSY_MESSAGE : RATE_LIMITED_MESSAGE;
  return NextResponse.json(
    { rateLimited: true, lockout: refusal.scope, retryAfterSeconds, error },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/** Test seam: the counters are process-wide. */
export function resetLoginLimiterForTests(): void {
  const state = limiterState();
  state.perAddress.clear();
  state.everyAddress.clear();
  state.verifyRunning = false;
}
