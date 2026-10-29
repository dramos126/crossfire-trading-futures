/**
 * `QUOTES_LOADED` merge rules. The REST snapshot and the SSE tick stream
 * both write `state.quotes`, and since the quote poll stopped being gated
 * on `!live` they write it concurrently — so which one wins is a decision
 * the reducer now has to make rather than an ordering that never arose.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { reducer } from "./reducer";
import { initialState, type TradingState } from "./types";

function withQuotes(quotes: TradingState["quotes"]): TradingState {
  return { ...initialState, quotes };
}

describe("reducer — QUOTES_LOADED", () => {
  it("merges rather than replaces, so a contract that failed this round keeps its mark", () => {
    const state = withQuotes({
      MNQM6: { mark: 24680, lastUpdated: "2026-08-22T13:31:00.000Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: { MESU6: { mark: 6700, lastUpdated: "2026-08-22T13:31:02.000Z" } },
    });

    expect(next.quotes.MNQM6.mark).toBe(24680);
    expect(next.quotes.MESU6.mark).toBe(6700);
  });

  it("takes a newer mark", () => {
    const state = withQuotes({
      MNQM6: { mark: 24680, lastUpdated: "2026-08-22T13:31:00.000Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: { MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" } },
    });

    expect(next.quotes.MNQM6.mark).toBe(24690);
  });

  it("does not walk a live mark backwards onto a partial bar's close", () => {
    // The REST mark is the close of the in-progress 1m bar, so it lags the
    // tick stream by up to a bar. Unconditional merge would step the number
    // back several seconds on every 10s reconcile.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: { MNQM6: { mark: 24680, lastUpdated: "2026-08-22T13:31:00.000Z" } },
    });

    expect(next.quotes.MNQM6.mark).toBe(24690);
  });

  it("compares instants, not strings — the two sources render ISO differently", () => {
    // Lexicographically "…:05Z" sorts after "…:05.500Z", which would drop
    // the newer of the two.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.500Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: { MNQM6: { mark: 24695, lastUpdated: "2026-08-22T13:31:06Z" } },
    });

    expect(next.quotes.MNQM6.mark).toBe(24695);
  });

  it("takes the incoming mark when a timestamp cannot be read at all", () => {
    // Withholding on an unparseable stamp would freeze the mark for the
    // life of the position; a stale number is the lesser failure here
    // because the next tick corrects it.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "not-a-date" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: { MNQM6: { mark: 24680, lastUpdated: "2026-08-22T13:31:00.000Z" } },
    });

    expect(next.quotes.MNQM6.mark).toBe(24680);
  });

  it("treats a zoneless stamp as unreadable rather than as local time", () => {
    // `Date.parse("2026-08-22T13:31:00")` is *local*, so against a UTC stamp
    // the comparison carries a silent offset and reorders across a DST
    // transition. The `NaN` guard above does not catch it.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: { MNQM6: { mark: 24680, lastUpdated: "2026-08-22T13:31:00" } },
    });

    expect(next.quotes.MNQM6.mark).toBe(24680);
  });

  it("drops a snapshot whose mark is not a finite number", () => {
    // The route body is an `as`-cast where the SSE side validates; a null or
    // NaN mark reaches the unrealized-P&L arithmetic unchallenged.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: {
        MNQM6: { mark: Number.NaN, lastUpdated: "2026-08-22T13:31:06.000Z" },
      },
    });

    expect(next.quotes.MNQM6.mark).toBe(24690);
  });

  it("survives a stamp that is not a string at all", () => {
    // Same `as`-cast as the mark guard above: `/api/quotes` writes
    // `lastUpdated` from `BarData.timestamp`, which the Topstep provider maps
    // straight off `b.t`. A missing `t` used to throw `stamp.trim()` inside
    // the polling `.then` and lose the whole update.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" },
    });

    const next = reducer(state, {
      type: "QUOTES_LOADED",
      quotes: {
        MNQM6: { mark: 24700, lastUpdated: undefined as unknown as string },
      },
    });

    expect(next.quotes.MNQM6.mark).toBe(24700);
  });
});

describe("reducer — LIVE_QUOTE", () => {
  it("takes a newer tick", () => {
    const state = withQuotes({
      MNQM6: { mark: 24680, lastUpdated: "2026-08-22T13:31:00.000Z" },
    });

    const next = reducer(state, {
      type: "LIVE_QUOTE",
      contractId: "MNQM6",
      snapshot: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" },
    });

    expect(next.quotes.MNQM6.mark).toBe(24690);
  });

  it("does not walk the mark backwards either — the invariant is the map's", () => {
    // Guarding only `QUOTES_LOADED` left a late-arriving tick able to
    // overwrite a newer mark, which is the same defect from the other side.
    const state = withQuotes({
      MNQM6: { mark: 24690, lastUpdated: "2026-08-22T13:31:05.000Z" },
    });

    const next = reducer(state, {
      type: "LIVE_QUOTE",
      contractId: "MNQM6",
      snapshot: { mark: 24680, lastUpdated: "2026-08-22T13:31:00.000Z" },
    });

    expect(next).toBe(state);
  });
});

// A tab whose session is refused stays `connected` forever: a route that 401s
// the held token must hand the provider back to `disconnected`, the one status
// that re-runs `connect()`, so `POST /api/auth` either re-mints or answers
// `needsSetup` and the guard redirects.
describe("reducer — SESSION_REFUSED (a refused session stays connected forever)", () => {
  const connected: TradingState = {
    ...initialState,
    status: "connected",
    token: "tok",
    live: true,
    positions: [
      { id: 1, accountId: 9001, contractId: "MNQM6", creationTimestamp: "2026-09-02T13:00:00.000Z", type: 1, size: 1, averagePrice: 24680 },
    ],
  };

  it("returns a connected session to disconnected and drops the refused token", () => {
    const next = reducer(connected, { type: "SESSION_REFUSED", token: "tok" });

    expect(next.status).toBe("disconnected");
    expect(next.token).toBeNull();
    expect(next.live).toBe(false);
  });

  it("keeps what the tab was showing — an expiring session re-mints, it does not blank the view", () => {
    const next = reducer(connected, { type: "SESSION_REFUSED", token: "tok" });

    expect(next.positions).toBe(connected.positions);
  });

  it("ignores a refusal of a token the tab no longer holds", () => {
    // A read issued under the old session can land its 401 after the provider
    // has already re-minted; that answer is about a session nobody holds.
    const next = reducer({ ...connected, token: "fresh" }, { type: "SESSION_REFUSED", token: "tok" });

    expect(next.status).toBe("connected");
    expect(next.token).toBe("fresh");
  });

  it("leaves the sticky terminals and an in-flight connect alone", () => {
    for (const status of ["error", "needsSetup", "connecting", "signedOut"] as const) {
      const state = { ...connected, status };
      expect(reducer(state, { type: "SESSION_REFUSED", token: "tok" })).toBe(state);
    }
  });
});

describe("reducer — SIGNED_OUT and the failure kind", () => {
  it("SIGNED_OUT drops the marker and stops the stream's flag", () => {
    const next = reducer(
      { ...initialState, status: "connected", token: "tok", live: true },
      { type: "SIGNED_OUT" },
    );
    expect(next).toMatchObject({ status: "signedOut", token: null, live: false, error: null });
  });

  it("ERROR keeps its kind through CONNECTING, so a retry still knows what it retries, and AUTHENTICATED clears it", () => {
    const failed = reducer(initialState, { type: "ERROR", error: "raw text", kind: "broker-refused" });
    const retrying = reducer(failed, { type: "CONNECTING" });
    expect(retrying).toMatchObject({ status: "connecting", error: null, errorKind: "broker-refused" });
    expect(reducer(retrying, { type: "AUTHENTICATED", token: "t" }).errorKind).toBeNull();
  });
});

describe("the orders slice is gone — the operator never used it (2026-10-27)", () => {
  it("is not in the state", () => {
    expect("orders" in initialState).toBe(false);
  });

  it("has no reader, writer or fetch left anywhere in src (source scan)", () => {
    const SRC = path.resolve(__dirname, "../../..");
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
      });
    })(SRC);
    expect(files.length).toBeGreaterThan(100);
    // `\bLIVE_ORDER\b` does not match `LIVE_ORDER_STATUSES`, the exit legs' set.
    const SLICE = /\bORDERS_LOADED\b|\bLIVE_ORDER\b|\bstate\.orders\b|["'`]\/api\/orders\b/;
    const hits = files.filter((f) => SLICE.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
