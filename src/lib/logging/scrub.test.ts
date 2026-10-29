import { describe, it, expect, vi, afterEach } from "vitest";
import {
  redactionEnabled,
  refreshManagedAccounts,
  scrubDisplay,
  scrubMessage,
  scrubMeta,
  setManagedAccountSource,
} from "./scrub";

/**
 * The canonical example token from jwt.io's own documentation — a real
 * JWT by structure, signed with the published sample secret, so nothing
 * here is a credential of this install.
 */
const SAMPLE_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

/**
 * Identifiers this repo actually issues, both long enough for the pattern
 * A7 reports on. The first is an exported function name
 * (`src/lib/db/trades.ts:897`) that reaches log lines through error
 * messages; the second is a backtest artifact name recorded in
 * `docs/process/strategy-research.md:206`.
 */
const REAL_LONG_SYMBOL = "listAccountsWithBracketManualClosedTrades";
const REAL_LONG_ARTIFACT = "results-opening-range-breakout-v2-NQM6-5m-2026-05-06-parity-confirmed";

/** A deployment uuid observed in the 2026-08-26 soak (logging-rework.md). */
const REAL_DEPLOYMENT_UUID = "758d19dd-f18d-42b0-a15b-9b6dffd896d5";

afterEach(() => {
  setManagedAccountSource(null);
  vi.unstubAllEnvs();
});

describe("A7 — the token rule masks credentials without eating identifiers", () => {
  it("masks a real JWT", () => {
    const out = scrubMessage(`auth: token=${SAMPLE_JWT}`);
    expect(out).not.toContain(SAMPLE_JWT);
    expect(out).not.toContain("dBjftJeZ4CVP");
    expect(out).toContain("…");
  });

  it("masks a base64url JSON header that is not a whole JWT", () => {
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const out = scrubMessage(`rejected header ${header}`);
    expect(out).not.toContain(header);
  });

  it("masks a Bearer credential and keeps the scheme greppable", () => {
    const out = scrubMessage("Authorization: Bearer sk9dJ2mQ8vXpL4nR7tZ0aB3cD6eF1gH5");
    expect(out).toContain("Bearer ");
    expect(out).not.toContain("sk9dJ2mQ8vXpL4nR7tZ0aB3cD6eF1gH5");
  });

  it("masks a 44-character opaque mixed-class key", () => {
    const key = "AKIA7fJ2Qx9LmZ3pTvB8Nc4RdW1yHs6EgK0iUa5OjPq2";
    const out = scrubMessage(`databento key ${key} rejected`);
    expect(out).not.toContain(key);
  });

  // The other direction: A7's whole complaint was that the bare
  // `{40,}` run destroys non-secret data permanently in `engine_logs`.
  it("leaves a 41-character symbol name from this repo intact", () => {
    expect(REAL_LONG_SYMBOL.length).toBeGreaterThanOrEqual(40);
    expect(scrubMessage(`reconcile: ${REAL_LONG_SYMBOL}() returned 0 accounts`)).toContain(
      REAL_LONG_SYMBOL,
    );
  });

  it("leaves a 68-character backtest artifact name intact", () => {
    expect(REAL_LONG_ARTIFACT.length).toBeGreaterThanOrEqual(40);
    expect(scrubMessage(`replay against ${REAL_LONG_ARTIFACT}.json`)).toContain(REAL_LONG_ARTIFACT);
  });

  it("leaves a deployment uuid intact", () => {
    expect(scrubMessage(`[${REAL_DEPLOYMENT_UUID}] entry filled`)).toContain(REAL_DEPLOYMENT_UUID);
  });

  it("leaves a 64-character hex digest intact — no uppercase, so not a credential shape", () => {
    const digest = "a".repeat(20) + "0123456789abcdef".repeat(2) + "b".repeat(12);
    expect(digest.length).toBeGreaterThanOrEqual(40);
    expect(scrubMessage(`bars checksum ${digest}`)).toContain(digest);
  });

  it("leaves a contract id and a url intact", () => {
    const line = "CON.F.US.MNQ.Z25 via https://api.topstepx.com/api/Contract/searchById";
    expect(scrubMessage(line)).toBe(line);
  });

  it("does not eat the next English word after Bearer", () => {
    expect(scrubMessage("missing Bearer auth on request")).toBe("missing Bearer auth on request");
  });
});

describe("managed account truncation", () => {
  it("truncates a managed account number to its last four digits", () => {
    setManagedAccountSource(() => [11444469]);
    expect(scrubMessage("account 11444469 flattened")).toBe("account …4469 flattened");
  });

  it("leaves an eight-digit number this install does not manage alone", () => {
    setManagedAccountSource(() => [11444469]);
    expect(scrubMessage("order 90210777 rejected")).toBe("order 90210777 rejected");
  });

  it("does not truncate a managed number embedded in a longer digit run", () => {
    setManagedAccountSource(() => [11444469]);
    expect(scrubMessage("seq 9114444690")).toBe("seq 9114444690");
  });

  it("truncates every managed account in one line", () => {
    setManagedAccountSource(() => [11444469, 11447788]);
    expect(scrubMessage("moving 11444469 → 11447788")).toBe("moving …4469 → …7788");
  });

  it("leaves an account number too short to truncate meaningfully", () => {
    setManagedAccountSource(() => [4469]);
    expect(scrubMessage("account 4469")).toBe("account 4469");
  });

  it("reads the set once and caches it across lines", () => {
    const read = vi.fn(() => [11444469]);
    setManagedAccountSource(read);
    scrubMessage("a 11444469");
    scrubMessage("b 11444469");
    scrubMessage("c 11444469");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("re-reads after refreshManagedAccounts", () => {
    const read = vi.fn(() => [11444469]);
    setManagedAccountSource(read);
    scrubMessage("a 11444469");
    refreshManagedAccounts();
    expect(scrubMessage("b 11444469")).toBe("b …4469");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("emits the line untruncated when the set cannot be read, and heals on refresh", () => {
    let broken = true;
    setManagedAccountSource(() => {
      if (broken) throw new Error("database unavailable");
      return [11444469];
    });
    expect(scrubMessage("account 11444469")).toBe("account 11444469");
    broken = false;
    refreshManagedAccounts();
    expect(scrubMessage("account 11444469")).toBe("account …4469");
  });

  it("does not recurse when reading the set logs through the scrubber itself", () => {
    setManagedAccountSource(() => {
      // Opening the database can log; that line must not re-enter here.
      scrubMessage("db: opened 11444469");
      return [11444469];
    });
    expect(scrubMessage("account 11444469")).toBe("account …4469");
  });
});

/**
 * The half the catalog rule could not cover.
 *
 * `scrubMessage`'s exact-match rule is right for free text and wrong for
 * `display`, because it makes truncation conditional on `account_brokers`
 * carrying the row — and until it does, the whole account number crosses the
 * durable column, the wire, both viewer lanes and an alert title. `display`
 * is `account-strategy.ticker` by construction, so the leading digit run is
 * an account and no lookup is needed to know it.
 */
describe("scrubDisplay — the account leg truncates without the catalog", () => {
  it("truncates the leading account of an uncatalogued display", () => {
    setManagedAccountSource(null);
    expect(scrubDisplay("11444469-ema-crossover.MNQ")).toBe("…4469-ema-crossover.MNQ");
  });

  it("answers identically for an account the catalog does carry", () => {
    setManagedAccountSource(() => [11444469]);
    expect(scrubDisplay("11444469-ema-crossover.MNQ")).toBe("…4469-ema-crossover.MNQ");
  });

  it("is positional — only the leading run, and only before the first dash", () => {
    setManagedAccountSource(null);
    // The strategy leg's own digits are not an account and must survive, or
    // two strategies whose keys differ only in a number read the same.
    expect(scrubDisplay("11444469-orb-v2-30m.MNQ")).toBe("…4469-orb-v2-30m.MNQ");
  });

  it("leaves a display with no account leg alone", () => {
    setManagedAccountSource(null);
    expect(scrubDisplay(REAL_DEPLOYMENT_UUID)).toBe(REAL_DEPLOYMENT_UUID);
  });

  it("leaves a run too short to be an account alone", () => {
    setManagedAccountSource(null);
    expect(scrubDisplay("4469-ema-crossover.MNQ")).toBe("4469-ema-crossover.MNQ");
  });

  it("still masks a token that reached the display slot", () => {
    setManagedAccountSource(null);
    expect(scrubDisplay(`11444469-${SAMPLE_JWT}.MNQ`)).not.toContain("dBjftJeZ4CVP");
  });
});

describe("scrubMeta", () => {
  it("masks values under sensitive keys whatever they look like", () => {
    expect(scrubMeta({ token: "short", apiKey: "abc", password: 1234 })).toEqual({
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      password: "[REDACTED]",
    });
  });

  it("masks every key ending in password, and the setup code", () => {
    const secret = "correct horse battery staple";
    const out = scrubMeta({
      currentPassword: secret,
      newPassword: secret,
      tradovate_password: secret,
      setupCode: secret,
    });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(scrubMeta({ passwordPolicy: "twelve" })).toEqual({ passwordPolicy: "twelve" });
  });

  // A head-and-tail mask suits a token found in free text; under a key that
  // names a secret it would still print ten characters of a password.
  it("keeps no characters of a long value under a sensitive key", () => {
    const secret = "correct horse battery staple";
    expect(scrubMeta({ newPassword: secret, setupCode: secret, apiKey: secret })).toEqual({
      newPassword: "[REDACTED]",
      setupCode: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
  });

  it("masks the sign-in cookie by its name, and the header it replaced", () => {
    const session = "a-session-token-value-of-any-shape";
    const out = scrubMeta({ crossfire_session: session, "x-session-token": session });
    expect(JSON.stringify(out)).not.toContain(session);
  });

  it("scrubs strings nested in arrays and objects", () => {
    const out = scrubMeta({ frames: [{ note: `bearer ${SAMPLE_JWT}` }] }) as {
      frames: Array<{ note: string }>;
    };
    expect(out.frames[0].note).not.toContain(SAMPLE_JWT);
  });

  it("truncates managed account numbers inside meta", () => {
    setManagedAccountSource(() => [11444469]);
    expect(scrubMeta({ accountLabel: "acct 11444469" })).toEqual({ accountLabel: "acct …4469" });
  });
});

describe("the LOG_REDACT escape hatch", () => {
  it("is on by default outside production", () => {
    expect(redactionEnabled()).toBe(true);
  });

  it("passes the line through untouched when a dev turns it off", () => {
    vi.stubEnv("LOG_REDACT", "off");
    setManagedAccountSource(() => [11444469]);
    expect(redactionEnabled()).toBe(false);
    expect(scrubMessage(`token ${SAMPLE_JWT} on 11444469`)).toBe(
      `token ${SAMPLE_JWT} on 11444469`,
    );
  });

  it("ignores the opt-out in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_REDACT", "off");
    expect(redactionEnabled()).toBe(true);
    expect(scrubMessage(`token ${SAMPLE_JWT}`)).not.toContain(SAMPLE_JWT);
  });
});
