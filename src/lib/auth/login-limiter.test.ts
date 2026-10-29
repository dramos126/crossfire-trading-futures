import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clientAddress,
  createLoginLimiter,
  limitedAttempt,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_GLOBAL_FAILURE_LIMIT,
  rateLimitedResponse,
  resetLoginLimiterForTests,
  VERIFY_BUSY_RETRY_MS,
} from "./login-limiter";

const T0 = 1_700_000_000_000;

describe("createLoginLimiter", () => {
  const limit = 3;
  const windowMs = 60_000;

  it("allows up to the limit of failures, then refuses until the window ends", () => {
    const limiter = createLoginLimiter({ limit, windowMs });
    for (let i = 0; i < limit - 1; i++) limiter.recordFailure("a", T0 + i);
    expect(limiter.check("a", T0 + 10)).toEqual({ allowed: true });
    limiter.recordFailure("a", T0 + 10);
    expect(limiter.check("a", T0 + 20)).toEqual({ allowed: false, retryAfterMs: windowMs - 20 });
    expect(limiter.check("a", T0 + windowMs)).toEqual({ allowed: true });
  });

  it("reports the failure that locked the key, and only that one", () => {
    const limiter = createLoginLimiter({ limit, windowMs });
    const locked = [1, 2, 3, 4].map((i) => limiter.recordFailure("a", T0 + i));
    expect(locked).toEqual([false, false, true, false]);
  });

  it("a success clears the count", () => {
    const limiter = createLoginLimiter({ limit, windowMs });
    limiter.recordFailure("a", T0);
    limiter.recordFailure("a", T0);
    limiter.recordSuccess("a");
    limiter.recordFailure("a", T0);
    limiter.recordFailure("a", T0);
    expect(limiter.check("a", T0)).toEqual({ allowed: true });
  });

  it("a refund takes back exactly one failure", () => {
    const limiter = createLoginLimiter({ limit, windowMs });
    for (let i = 0; i < limit; i++) limiter.recordFailure("a", T0);
    limiter.refund("a");
    expect(limiter.check("a", T0)).toEqual({ allowed: true });
    limiter.recordFailure("a", T0);
    expect(limiter.check("a", T0).allowed).toBe(false);
  });

  it("counts each key on its own", () => {
    const limiter = createLoginLimiter({ limit, windowMs });
    for (let i = 0; i < limit; i++) limiter.recordFailure("a", T0);
    expect(limiter.check("a", T0).allowed).toBe(false);
    expect(limiter.check("b", T0).allowed).toBe(true);
  });

  it("never holds more than its cap of keys — expired windows go first, then the oldest", () => {
    const limiter = createLoginLimiter({ limit, windowMs, maxKeys: 3 });
    limiter.recordFailure("expired", T0);
    limiter.recordFailure("old", T0 + windowMs - 1);
    limiter.recordFailure("newer", T0 + windowMs);
    limiter.recordFailure("fourth", T0 + windowMs + 1);
    expect(limiter.size()).toBe(3);
    limiter.recordFailure("fifth", T0 + windowMs + 2);
    expect(limiter.size()).toBe(3);
    // "expired" went to its window, "old" to the cap; "newer" survives both.
    for (let i = 1; i < limit; i++) limiter.recordFailure("newer", T0 + windowMs + 3);
    expect(limiter.check("newer", T0 + windowMs + 3).allowed).toBe(false);
  });
});

describe("limitedAttempt — the process's counters", () => {
  beforeEach(() => resetLoginLimiterForTests());

  const wrong = () => limitedAttempt("10.0.0.1", async () => false, (ok) => ok);

  it(`locks an address after ${LOGIN_FAILURE_LIMIT} wrong attempts for ${LOGIN_FAILURE_WINDOW_MS / 60_000} minutes`, async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) expect((await wrong()).refusal).toBeNull();
    const locked = await wrong();
    expect(locked.refusal).toMatchObject({ scope: "address" });
    const other = await limitedAttempt("10.0.0.2", async () => true, (ok) => ok);
    expect(other).toMatchObject({ refusal: null, passed: true });
  });

  it("is one counter per process, not per module graph — a second copy of the module sees the lockout", async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await wrong();
    vi.resetModules();
    const fresh = await import("./login-limiter");
    const again = await fresh.limitedAttempt("10.0.0.1", async () => true, (ok) => ok);
    expect(again.refusal).toMatchObject({ scope: "address" });
  });

  it("reports the attempt that locked the address", async () => {
    const results = [];
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) results.push(await wrong());
    expect(results.map((r) => (r.refusal === null ? r.lockedOut : null))).toEqual([
      ...Array<boolean>(LOGIN_FAILURE_LIMIT - 1).fill(false),
      true,
    ]);
  });

  // Counted before the await: an attempt that throws mid-check is still a
  // failure. Counted after, a throw (or a request arriving during the await)
  // would never have been counted.
  it("counts the attempt before the check runs — a throwing check still counts", async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await expect(
        limitedAttempt("10.0.0.1", async () => Promise.reject(new Error("pool")), () => true),
      ).rejects.toThrow("pool");
    }
    expect((await wrong()).refusal).toMatchObject({ scope: "address" });
  });

  it("one check at a time: a second while one runs is refused as busy, and runs nothing", async () => {
    let release!: (ok: boolean) => void;
    let ran = 0;
    const first = limitedAttempt("10.0.0.1", () => new Promise<boolean>((r) => (release = r)), (ok) => ok);
    const second = await limitedAttempt(
      "10.0.0.2",
      async () => {
        ran += 1;
        return true;
      },
      (ok) => ok,
    );
    expect(second).toEqual({ refusal: { scope: "busy", retryAfterMs: VERIFY_BUSY_RETRY_MS } });
    expect(ran).toBe(0);
    release(true);
    expect(await first).toMatchObject({ passed: true });
    expect(await limitedAttempt("10.0.0.2", async () => true, (ok) => ok)).toMatchObject({ passed: true });
  });

  it("locks every address once failures across addresses pass the global ceiling — a guesser naming a new address per request", async () => {
    for (let i = 0; i < LOGIN_GLOBAL_FAILURE_LIMIT; i++) {
      await limitedAttempt(`spoofed-${i}`, async () => false, (ok) => ok);
    }
    const refused = await limitedAttempt("never-seen", async () => true, (ok) => ok);
    expect(refused.refusal).toMatchObject({ scope: "server" });
  });

  it("a session-gated caller reads its own address only — the global ceiling never reaches it", async () => {
    for (let i = 0; i < LOGIN_GLOBAL_FAILURE_LIMIT; i++) {
      await limitedAttempt(`spoofed-${i}`, async () => false, (ok) => ok);
    }
    const own = await limitedAttempt("owner", async () => true, (ok) => ok, { serverWide: false });
    expect(own).toMatchObject({ refusal: null, passed: true });
  });

  it("a right attempt clears its address and refunds its own global count, but not the others'", async () => {
    for (let i = 0; i < LOGIN_GLOBAL_FAILURE_LIMIT - 1; i++) {
      await limitedAttempt(`spoofed-${i}`, async () => false, (ok) => ok);
    }
    // Counted up front to the ceiling, then refunded: one under it again.
    expect(await limitedAttempt("owner", async () => true, (ok) => ok)).toMatchObject({ passed: true });
    await limitedAttempt("one-more", async () => false, (ok) => ok);
    const after = await limitedAttempt("owner", async () => true, (ok) => ok);
    expect(after.refusal).toMatchObject({ scope: "server" });
  });
});

describe("rateLimitedResponse", () => {
  it("names the lockout and carries Retry-After in whole seconds", async () => {
    const res = rateLimitedResponse({ scope: "server", retryAfterMs: 1_500 });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toMatchObject({ rateLimited: true, lockout: "server", retryAfterSeconds: 2 });
  });
});

describe("clientAddress", () => {
  it("takes the first forwarded hop", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe(
      "203.0.113.5",
    );
  });

  it("falls back to one shared key when nothing names the address", () => {
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});
