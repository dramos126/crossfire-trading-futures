import { describe, it, expect } from "vitest";
import { InMemorySlotStore, MarketDataRegistry } from "./registry";
import type { MarketDataCapabilities, MarketDataProvider } from "./provider";

// ── Stub factory ──────────────────────────────────────────────────────────────

function makeProvider(
  id: string,
  capabilities: Partial<MarketDataCapabilities> = {},
): MarketDataProvider {
  return {
    id,
    displayName: id,
    capabilities: {
      historicalBars: true,
      liveBars: true,
      liveQuotes: true,
      ...capabilities,
    },
    isConfigured: () => true,
    retrieveBars: async () => [],
    credentialSchema: () => [],
    testConnection: async () => undefined,
    classifyError: () => "network",
  };
}

/** History-only, the shape the Databento provider has on the Usage-based plan. */
function makeArchiveProvider(id = "databento"): MarketDataProvider {
  return makeProvider(id, { liveBars: false, liveQuotes: false });
}

// ── MarketDataRegistry ────────────────────────────────────────────────────────

describe("MarketDataRegistry", () => {
  it("register then getProvider round-trip returns the same provider", () => {
    const reg = new MarketDataRegistry();
    const p = makeProvider("topstep");
    reg.register(p);
    expect(reg.getProvider("topstep")).toBe(p);
  });

  it("getProvider with unknown id returns null", () => {
    const reg = new MarketDataRegistry();
    expect(reg.getProvider("unknown")).toBeNull();
  });

  it("allProviders lists every registered provider", () => {
    const reg = new MarketDataRegistry();
    const a = makeProvider("topstep");
    const b = makeArchiveProvider();
    reg.register(a);
    reg.register(b);
    expect(reg.allProviders()).toEqual([a, b]);
  });

  it("double-register same id: second registration overwrites the first", () => {
    const reg = new MarketDataRegistry();
    const first = makeProvider("topstep");
    const second = makeProvider("topstep");
    reg.register(first);
    reg.register(second);
    expect(reg.getProvider("topstep")).toBe(second);
    expect(reg.getProvider("topstep")).not.toBe(first);
  });

  // ── Slots ───────────────────────────────────────────────────────────────────

  it("historical and realtime resolve independently", () => {
    const reg = new MarketDataRegistry();
    const topstep = makeProvider("topstep");
    const databento = makeArchiveProvider();
    reg.register(topstep);
    reg.register(databento);

    reg.setSlot("historical", "databento");
    reg.setSlot("realtime", "topstep");

    expect(reg.historical()).toBe(databento);
    expect(reg.realtime()).toBe(topstep);
  });

  it("setting the historical slot leaves the realtime slot alone", () => {
    const reg = new MarketDataRegistry(new InMemorySlotStore("topstep"));
    const topstep = makeProvider("topstep");
    reg.register(topstep);
    reg.register(makeArchiveProvider());

    reg.setSlot("historical", "databento");

    expect(reg.slotProviderId("realtime")).toBe("topstep");
    expect(reg.realtime()).toBe(topstep);
  });

  it("refuses the realtime slot for a provider without liveBars", () => {
    const reg = new MarketDataRegistry();
    reg.register(makeArchiveProvider());
    expect(() => reg.setSlot("realtime", "databento")).toThrow("cannot serve the realtime slot");
  });

  it("leaves the realtime selection untouched when the refusal fires", () => {
    const reg = new MarketDataRegistry(new InMemorySlotStore("topstep"));
    reg.register(makeProvider("topstep"));
    reg.register(makeArchiveProvider());

    expect(() => reg.setSlot("realtime", "databento")).toThrow();

    expect(reg.slotProviderId("realtime")).toBe("topstep");
  });

  it("assertSlot accepts a valid selection without writing it", () => {
    const reg = new MarketDataRegistry(new InMemorySlotStore("topstep"));
    reg.register(makeProvider("topstep"));
    reg.register(makeArchiveProvider());

    reg.assertSlot("historical", "databento");

    expect(reg.slotProviderId("historical")).toBe("topstep");
  });

  it("assertSlot throws the same refusal setSlot would", () => {
    const reg = new MarketDataRegistry();
    reg.register(makeArchiveProvider());
    expect(() => reg.assertSlot("realtime", "databento")).toThrow("cannot serve the realtime slot");
    expect(() => reg.assertSlot("historical", "ghost")).toThrow("is not registered");
  });

  it("refuses the historical slot for a provider without historicalBars", () => {
    const reg = new MarketDataRegistry();
    reg.register(makeProvider("liveonly", { historicalBars: false }));
    expect(() => reg.setSlot("historical", "liveonly")).toThrow(
      "cannot serve the historical slot",
    );
  });

  it("setSlot with an unregistered id throws an error that includes the id", () => {
    const reg = new MarketDataRegistry();
    expect(() => reg.setSlot("historical", "databento")).toThrow("databento");
  });

  it("resolving a slot with nothing selected throws", () => {
    const reg = new MarketDataRegistry();
    reg.register(makeProvider("topstep"));
    expect(() => reg.historical()).toThrow("No historical MarketDataProvider selected");
    expect(() => reg.realtime()).toThrow("No realtime MarketDataProvider selected");
  });

  it("resolving a slot pointing at an unregistered provider throws", () => {
    const reg = new MarketDataRegistry(new InMemorySlotStore("ghost"));
    expect(() => reg.historical()).toThrow("is not registered");
  });

  it("realtime() throws when a persisted selection has since lost liveBars", () => {
    // The store bypasses setSlot's guard, which is what a selection made
    // under a live entitlement that was later revoked looks like.
    const reg = new MarketDataRegistry(new InMemorySlotStore("databento"));
    reg.register(makeArchiveProvider());
    expect(() => reg.realtime()).toThrow("no longer declares liveBars");
  });

  it("historical() serves an archive-only provider without complaint", () => {
    const reg = new MarketDataRegistry(new InMemorySlotStore("databento"));
    const databento = makeArchiveProvider();
    reg.register(databento);
    expect(reg.historical()).toBe(databento);
  });

  it("a store default applies to both slots until something is selected", () => {
    const reg = new MarketDataRegistry(new InMemorySlotStore("topstep"));
    const topstep = makeProvider("topstep");
    reg.register(topstep);
    expect(reg.historical()).toBe(topstep);
    expect(reg.realtime()).toBe(topstep);
  });
});
