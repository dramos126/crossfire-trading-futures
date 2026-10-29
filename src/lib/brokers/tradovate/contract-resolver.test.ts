import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetLogBursts } from "@/lib/logging/pipe";
import { TradovateContractResolver, stripContinuousSuffix } from "./contract-resolver";
import type { TradovateClient } from "./client";
import type { TradovateContractSuggestion } from "./types";

/**
 * Fixtures are the identifiers observed in the 2026-09-11 staging failure:
 * Topstep `MNQU6` / `CON.F.US.MNQ.U26` against Tradovate `MNQZ6` id 4470324
 * expiring 2026-12-18T14:30:00.000Z, which is the pair the mismatch error
 * named. MNQU26's own settlement is 2026-09-18T13:30:00Z.
 */
const ANCHOR_U26 = "CON.F.US.MNQ.U26";
const ANCHOR_Z26 = "CON.F.US.MNQ.Z26";

const MNQU6: TradovateContractSuggestion = {
  id: 4470323,
  name: "MNQU6",
  contractMaturityId: 1001,
};
const MNQZ6: TradovateContractSuggestion = {
  id: 4470324,
  name: "MNQZ6",
  contractMaturityId: 1002,
};

const MATURITIES: Record<number, string> = {
  1001: "2026-09-18T13:30:00.000Z",
  1002: "2026-12-18T14:30:00.000Z",
};

type ResolverClient = Pick<TradovateClient, "suggestContracts" | "getContractMaturity">;

function makeClient(suggestions: TradovateContractSuggestion[]) {
  const client = {
    suggestContracts: vi.fn(async (_root: string) => suggestions),
    getContractMaturity: vi.fn(async (id: number) => {
      const expirationDate = MATURITIES[id];
      return expirationDate === undefined ? null : { id, expirationDate };
    }),
  } satisfies ResolverClient;
  return client;
}

function makeResolver(suggestions: TradovateContractSuggestion[]) {
  const client = makeClient(suggestions);
  const resolver = new TradovateContractResolver(client as unknown as TradovateClient);
  return { client, resolver };
}

describe("TradovateContractResolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 09:30:01 ET on 2026-09-11 — the instant the staging failures started,
    // and exactly one second inside the deleted 7-day roll window for
    // MNQU26 (settles 2026-09-18T13:30:00Z).
    vi.setSystemTime(new Date("2026-09-11T13:30:01.000Z"));
    resetLogBursts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the Topstep-anchored month even one second inside the old roll window", async () => {
    const { resolver } = makeResolver([MNQU6, MNQZ6]);

    const contract = await resolver.resolveForMonth("MNQ", ANCHOR_U26);

    expect(contract.symbol).toBe("MNQU6");
    expect(contract.contractId).toBe(4470323);
    expect(contract.maturityIso).toBe("2026-09-18T13:30:00.000Z");
  });

  it("asks for the maturity of the matched suggestion only", async () => {
    const { client, resolver } = makeResolver([MNQU6, MNQZ6]);

    await resolver.resolveForMonth("MNQ", ANCHOR_U26);

    expect(client.getContractMaturity).toHaveBeenCalledTimes(1);
    expect(client.getContractMaturity).toHaveBeenCalledWith(1001);
  });

  it("throws when Tradovate does not list the anchor month", async () => {
    const { resolver } = makeResolver([MNQZ6]);

    await expect(resolver.resolveForMonth("MNQ", ANCHOR_U26)).rejects.toThrow(
      /U2026[\s\S]*MNQ[\s\S]*MNQZ6/,
    );
  });

  it("follows Topstep to the next month with no explicit invalidate", async () => {
    const { resolver } = makeResolver([MNQU6, MNQZ6]);

    expect((await resolver.resolveForMonth("MNQ", ANCHOR_U26)).symbol).toBe("MNQU6");
    expect((await resolver.resolveForMonth("MNQ", ANCHOR_Z26)).symbol).toBe("MNQZ6");
  });

  it("carries the dated symbol from a suggestion that populates `symbol` and not `name`", async () => {
    // `suggestContracts` admits these (client.ts filters on `name || symbol`),
    // so the resolver must read the same way it matched. Reading `name` raw
    // returns symbol `""`, which `assertContractsPair` rejects as unparseable
    // — refusing every entry and every exit on an error naming no contract.
    const symbolOnly: TradovateContractSuggestion = {
      id: 4470323,
      name: "",
      symbol: "MNQU6",
      contractMaturityId: 1001,
    };
    const { resolver } = makeResolver([symbolOnly, MNQZ6]);

    expect((await resolver.resolveForMonth("MNQ", ANCHOR_U26)).symbol).toBe("MNQU6");
  });

  it("does not let the suggest ordering decide the answer", async () => {
    const forward = makeResolver([MNQU6, MNQZ6]);
    const reversed = makeResolver([MNQZ6, MNQU6]);

    const a = await forward.resolver.resolveForMonth("MNQ", ANCHOR_U26);
    const b = await reversed.resolver.resolveForMonth("MNQ", ANCHOR_U26);

    expect(b.symbol).toBe(a.symbol);
    expect(b.contractId).toBe(a.contractId);
  });

  it("serves a repeat resolution of the same month from the cache", async () => {
    const { client, resolver } = makeResolver([MNQU6, MNQZ6]);

    await resolver.resolveForMonth("MNQ", ANCHOR_U26);
    await resolver.resolveForMonth("MNQ", ANCHOR_U26);

    expect(client.suggestContracts).toHaveBeenCalledTimes(1);
  });

  it("reverse-looks-up a numeric contract id across months held in the cache", async () => {
    const { resolver } = makeResolver([MNQU6, MNQZ6]);

    await resolver.resolveForMonth("MNQ", ANCHOR_U26);
    await resolver.resolveForMonth("MNQ", ANCHOR_Z26);

    expect(resolver.getSymbolForNumericId(4470323)).toBe("MNQU6");
    expect(resolver.getSymbolForNumericId(4470324)).toBe("MNQZ6");
    expect(resolver.getSymbolForNumericId(1)).toBeNull();
  });

  it("drops every month of a root on invalidate", async () => {
    const { resolver } = makeResolver([MNQU6, MNQZ6]);

    await resolver.resolveForMonth("MNQ", ANCHOR_U26);
    await resolver.resolveForMonth("MNQ", ANCHOR_Z26);
    resolver.invalidate("MNQ");

    expect(resolver.getSymbolForNumericId(4470323)).toBeNull();
    expect(resolver.getSymbolForNumericId(4470324)).toBeNull();
  });

  it("refuses an anchor whose month it cannot read", async () => {
    const { client, resolver } = makeResolver([MNQU6, MNQZ6]);

    await expect(resolver.resolveForMonth("MNQ", "CON.F.US.MNQ")).rejects.toThrow(
      /CON\.F\.US\.MNQ/,
    );
    expect(client.suggestContracts).not.toHaveBeenCalled();
  });

  it("refuses an empty root", async () => {
    const { resolver } = makeResolver([MNQU6, MNQZ6]);

    await expect(resolver.resolveForMonth("  ", ANCHOR_U26)).rejects.toThrow(/empty root/);
  });
});

describe("stripContinuousSuffix", () => {
  it("strips the Topstep slash prefix and the TradingView continuous suffix", () => {
    expect(stripContinuousSuffix("/MNQ")).toBe("MNQ");
    expect(stripContinuousSuffix("mes1!")).toBe("MES");
  });
});
