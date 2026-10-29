import { describe, it, expect, vi, beforeEach } from "vitest";

// The provider reaches the Topstep provider through `cached-bars` (the
// chained tail), and that import reaches the Tradovate plugin and the
// strategy loader's bundler-only `require.context`. Cut it at the broker
// registry — every case here fails before any provider is touched.
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { getPlugin: vi.fn(() => null) },
}));

// `testConnection` persists on success; there is no test database.
vi.mock("@/lib/db/cred-validation", () => ({
  computeDatabentoCredsSignature: vi.fn(() => "sig"),
  setDatabentoCredsValidatedSignature: vi.fn(),
  setDatabentoCredsValidatedAt: vi.fn(),
}));
vi.mock("@/lib/db/settings", () => ({ setDatabentoProbeRange: vi.fn() }));
vi.mock("@/lib/db/settings-cache", () => ({ resolveDatabentoApiKey: vi.fn(() => null) }));

import { cacheSymbolForContractId, databentoMarketDataProvider } from "./provider";
import { resolveDatabentoApiKey } from "@/lib/db/settings-cache";
import {
  setDatabentoCredsValidatedSignature,
  setDatabentoCredsValidatedAt,
} from "@/lib/db/cred-validation";
import { setDatabentoProbeRange } from "@/lib/db/settings";

function request(overrides: Partial<Parameters<typeof databentoMarketDataProvider.retrieveBars>[0]> = {}) {
  return {
    contractId: "CON.F.US.ENQ.M26",
    live: false,
    startTime: "2026-01-01T00:00:00Z",
    endTime: "2026-01-02T00:00:00Z",
    unit: 2 as const,
    unitNumber: 1,
    limit: 100,
    includePartialBar: false,
    ...overrides,
  };
}

describe("cacheSymbolForContractId", () => {
  it("maps a Topstep id-root back to its continuous cache symbol", () => {
    expect(cacheSymbolForContractId("CON.F.US.ENQ.M26")).toBe("NQ.c.0");
    expect(cacheSymbolForContractId("CON.F.US.MNQ.M26")).toBe("MNQ.v.0");
    expect(cacheSymbolForContractId("CON.F.US.EP.H26")).toBe("ES.c.0");
  });

  it("returns null for a product with no cache coverage", () => {
    // CLE resolves to /CL, which is a known ticker but is not backfilled.
    expect(cacheSymbolForContractId("CON.F.US.CLE.N26")).toBeNull();
  });

  it("returns null for an unrecognised id-root", () => {
    expect(cacheSymbolForContractId("CON.F.US.ZZZ.M26")).toBeNull();
  });

  it("returns null for a contract id with no root segment", () => {
    expect(cacheSymbolForContractId("MNQM6")).toBeNull();
  });
});

describe("DatabentoMarketDataProvider", () => {
  it("declares historical bars only — the Usage-based plan has no live entitlement", () => {
    expect(databentoMarketDataProvider.capabilities).toEqual({
      historicalBars: true,
      liveBars: false,
      liveQuotes: false,
    });
  });

  it("rejects a live request rather than silently serving stale cache bars", async () => {
    await expect(
      databentoMarketDataProvider.retrieveBars(request({ live: true })),
    ).rejects.toThrow("cannot serve live bars");
  });

  it("throws on a contract it has no cache symbol for instead of returning empty", async () => {
    await expect(
      databentoMarketDataProvider.retrieveBars(request({ contractId: "CON.F.US.CLE.N26" })),
    ).rejects.toThrow("no cache symbol");
  });

  it("throws on a bar unit it cannot aggregate", async () => {
    await expect(
      databentoMarketDataProvider.retrieveBars(request({ unit: 2, unitNumber: 7 })),
    ).rejects.toThrow("cannot aggregate");
  });

  it("declares its API key as an optional credential", () => {
    expect(databentoMarketDataProvider.credentialSchema()).toEqual([
      {
        key: "databentoApiKey",
        label: "Databento API Key",
        secret: true,
        required: false,
        envFallback: "DATABENTO_API_KEY",
      },
    ]);
  });
});

describe("DatabentoMarketDataProvider.testConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveDatabentoApiKey).mockReturnValue(null);
  });

  it("throws config_missing when no key is stored or typed", async () => {
    await expect(databentoMarketDataProvider.testConnection()).rejects.toThrow(
      "No Databento API key configured",
    );
    const err = await databentoMarketDataProvider.testConnection().catch((e: unknown) => e);
    expect(databentoMarketDataProvider.classifyError(err)).toBe("config_missing");
  });

  it("classifies a 403 as entitlement, not auth — the plan is the problem, not the key", async () => {
    vi.mocked(resolveDatabentoApiKey).mockReturnValue("db-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "no live entitlement on this plan",
      }),
    );
    const err = await databentoMarketDataProvider.testConnection().catch((e: unknown) => e);
    expect(databentoMarketDataProvider.classifyError(err)).toBe("entitlement");
    expect((err as Error).message).toContain("no live entitlement on this plan");
    vi.unstubAllGlobals();
  });

  it("classifies a 401 as auth", async () => {
    vi.mocked(resolveDatabentoApiKey).mockReturnValue("db-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "bad key",
      }),
    );
    const err = await databentoMarketDataProvider.testConnection().catch((e: unknown) => e);
    expect(databentoMarketDataProvider.classifyError(err)).toBe("auth");
    vi.unstubAllGlobals();
  });

  it("persists the signature, the timestamp and the range on success", async () => {
    vi.mocked(resolveDatabentoApiKey).mockReturnValue("db-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => '{"start":"2019-01-01T00:00:00Z","end":"2026-08-20T00:00:00Z"}',
      }),
    );
    const meta = (await databentoMarketDataProvider.testConnection()) as {
      dataset: string;
      range: { start: string; end: string };
    };
    expect(meta.dataset).toBe("GLBX.MDP3");
    expect(meta.range.end).toBe("2026-08-20T00:00:00Z");
    expect(setDatabentoCredsValidatedSignature).toHaveBeenCalledWith("sig");
    expect(setDatabentoCredsValidatedAt).toHaveBeenCalledTimes(1);
    expect(setDatabentoProbeRange).toHaveBeenCalledWith(
      expect.objectContaining({ dataset: "GLBX.MDP3", end: "2026-08-20T00:00:00Z" }),
    );
    vi.unstubAllGlobals();
  });

  it("probes a typed key without persisting it, and never falls back to the stored one", async () => {
    vi.mocked(resolveDatabentoApiKey).mockReturnValue("stored-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => '{"start":"2019-01-01T00:00:00Z","end":"2026-08-20T00:00:00Z"}',
    });
    vi.stubGlobal("fetch", fetchMock);
    await databentoMarketDataProvider.testConnection({ databentoApiKey: "typed-key" });
    const header = fetchMock.mock.calls[0][1].headers.Authorization as string;
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("typed-key:");
    vi.unstubAllGlobals();
  });

  it("maps an unreadable success body to network rather than inventing a shape", async () => {
    vi.mocked(resolveDatabentoApiKey).mockReturnValue("db-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => '{"available_start":"2019-01-01"}',
      }),
    );
    const err = await databentoMarketDataProvider.testConnection().catch((e: unknown) => e);
    expect(databentoMarketDataProvider.classifyError(err)).toBe("network");
    expect((err as Error).message).toContain("available_start");
    vi.unstubAllGlobals();
  });
});
