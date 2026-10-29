import { describe, it, expect, vi, afterEach } from "vitest";

import {
  DEFAULT_DATASET,
  parseDatasetRange,
  probeFailureKindForStatus,
  probeHistoricalEntitlement,
} from "./metadata";

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchArgs = [string, { headers: Record<string, string> }];

function stubFetch(impl: (...args: FetchArgs) => Promise<unknown>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function okResponse(body: string) {
  return { ok: true, status: 200, statusText: "OK", text: async () => body };
}

function errResponse(status: number, statusText: string, body: string) {
  return { ok: false, status, statusText, text: async () => body };
}

describe("parseDatasetRange", () => {
  it("returns start and end from a flat range body", () => {
    const range = parseDatasetRange('{"start":"2010-06-06T00:00:00Z","end":"2026-08-20T21:00:00Z"}');
    expect(range).toEqual({ start: "2010-06-06T00:00:00Z", end: "2026-08-20T21:00:00Z" });
  });

  it("returns null on malformed JSON", () => {
    expect(parseDatasetRange("not json")).toBeNull();
  });

  it("returns null when end is absent", () => {
    expect(parseDatasetRange('{"start":"2010-06-06T00:00:00Z"}')).toBeNull();
  });

  it("returns null when start is not a string", () => {
    expect(parseDatasetRange('{"start":1275782400,"end":"2026-08-20T21:00:00Z"}')).toBeNull();
  });

  it("returns null on empty string values rather than reporting an empty range", () => {
    expect(parseDatasetRange('{"start":"","end":""}')).toBeNull();
  });

  it("returns null for a nested per-schema shape rather than coercing it", () => {
    // Captured shape unknown; a null here surfaces the raw body in the probe
    // message, which is how the real shape gets recorded instead of guessed.
    expect(parseDatasetRange('{"ohlcv-1m":{"start":"a","end":"b"}}')).toBeNull();
  });

  it("does not accept an inherited property as start", () => {
    expect(parseDatasetRange('{"__proto__":{"start":"a","end":"b"}}')).toBeNull();
  });
});

describe("probeFailureKindForStatus", () => {
  it("maps 401 to auth and 403 to entitlement", () => {
    expect(probeFailureKindForStatus(401)).toBe("auth");
    expect(probeFailureKindForStatus(403)).toBe("entitlement");
  });

  it("maps 422 to entitlement — Databento's out-of-range shape", () => {
    expect(probeFailureKindForStatus(422)).toBe("entitlement");
  });

  it("maps 429 to rate_limited and 5xx to network", () => {
    expect(probeFailureKindForStatus(429)).toBe("rate_limited");
    expect(probeFailureKindForStatus(503)).toBe("network");
  });

  it("maps an unrecognised 4xx to unknown", () => {
    expect(probeFailureKindForStatus(418)).toBe("unknown");
  });
});

describe("probeHistoricalEntitlement", () => {
  it("returns config_missing without calling out when the key is null", async () => {
    const fetchMock = stubFetch(async () => okResponse("{}"));

    const result = await probeHistoricalEntitlement(null);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("config_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the parsed range on success and defaults to the CME dataset", async () => {
    const fetchMock = stubFetch(async () =>
      okResponse('{"start":"2010-06-06T00:00:00Z","end":"2026-08-20T21:00:00Z"}'),
    );

    const result = await probeHistoricalEntitlement("db-key");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataset).toBe(DEFAULT_DATASET);
      expect(result.range.end).toBe("2026-08-20T21:00:00Z");
    }
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`dataset=${encodeURIComponent(DEFAULT_DATASET)}`);
  });

  it("sends the key as HTTP basic auth with an empty password", async () => {
    const fetchMock = stubFetch(async () => okResponse('{"start":"a","end":"b"}'));

    await probeHistoricalEntitlement("db-key");

    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("db-key:").toString("base64")}`,
    );
  });

  it("classifies a 403 as entitlement and carries the gateway's own text", async () => {
    stubFetch(async () => errResponse(403, "Forbidden", '{"detail":"no live entitlement"}'));

    const result = await probeHistoricalEntitlement("db-key");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("entitlement");
      expect(result.message).toContain("no live entitlement");
    }
  });

  it("reports the raw body when the range shape is unrecognised", async () => {
    stubFetch(async () => okResponse('{"unexpected":true}'));

    const result = await probeHistoricalEntitlement("db-key");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unknown");
      expect(result.message).toContain('{"unexpected":true}');
    }
  });

  it("returns a network failure instead of throwing when fetch rejects", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await probeHistoricalEntitlement("db-key");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      expect(result.message).toContain("fetch failed");
    }
  });
});
