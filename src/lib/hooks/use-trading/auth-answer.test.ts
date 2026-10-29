import { describe, expect, it } from "vitest";
import {
  authFailureCopy,
  NO_BROKER_COPY,
  rateLimitedFailure,
  readAuthAnswer,
  VERIFY_BUSY_COPY,
} from "./auth-answer";

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

describe("a signed-in answer says whether there is a broker", () => {
  it("reads only an explicit false as no broker", () => {
    const read = (body: unknown) => readAuthAnswer(200, body);
    expect(read({ signedIn: true, engineReady: false, brokerConfigured: false })).toMatchObject({
      kind: "signed-in",
      brokerConfigured: false,
    });
    expect(read({ signedIn: true, engineReady: true, brokerConfigured: true })).toMatchObject({ brokerConfigured: true });
    expect(read({ signedIn: true, engineReady: true })).toMatchObject({ brokerConfigured: true });
  });

  it("words a missing broker the same way on the error banner as everywhere else", () => {
    expect(authFailureCopy({ kind: "broker-not-configured" })).toBe(NO_BROKER_COPY);
  });
});
