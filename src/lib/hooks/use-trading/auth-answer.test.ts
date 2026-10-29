import { describe, expect, it } from "vitest";
import { authFailureCopy, rateLimitedFailure, readAuthAnswer, VERIFY_BUSY_COPY } from "./auth-answer";

function copyOf429(body: unknown): string {
  const answer = readAuthAnswer(429, body);
  if (answer.kind !== "failed") throw new Error(`expected a failure, got ${answer.kind}`);
  return authFailureCopy(answer.failure);
}

describe("a 429's sentence says whose lockout it is", () => {
  it("names the address for an address lockout", () => {
    expect(copyOf429({ rateLimited: true, lockout: "address", retryAfterSeconds: 840 })).toBe(
      "Too many wrong sign-ins from this address. Try again in 14 minutes.",
    );
  });

  it("names the server during a global lockout, not the reader's address", () => {
    expect(copyOf429({ rateLimited: true, lockout: "server", retryAfterSeconds: 600 })).toBe(
      "Too many wrong sign-ins on this server. Try again in 10 minutes.",
    );
  });

  it("is no lockout at all when another check was running", () => {
    expect(copyOf429({ rateLimited: true, lockout: "busy", retryAfterSeconds: 1 })).toBe(VERIFY_BUSY_COPY);
  });

  it("reads a body that names no lockout as the address's", () => {
    expect(rateLimitedFailure({ retryAfterSeconds: 45 })).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 45,
      scope: "address",
    });
  });
});
