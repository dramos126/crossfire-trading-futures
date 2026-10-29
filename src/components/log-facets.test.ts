import { describe, it, expect } from "vitest";
import type { WireLogRecord } from "@/lib/logging/pipe";
import {
  DEFAULT_FACET_STATE,
  applyFacets,
  buildFacets,
  clearFacetDimension,
  scopeToDeployments,
  toggleFacet,
  type FacetState,
} from "./log-facets";

const DEPLOYMENT = "758d19dd-f18d-42b0-a15b-9b6dffd896d5";
const OTHER = "9a1c2b3d-4e5f-6789-abcd-ef0123456789";

function record(over: Partial<WireLogRecord> = {}): WireLogRecord {
  return {
    timestamp: "2026-08-27T13:58:00.000Z",
    deploymentId: DEPLOYMENT,
    level: "info",
    message: "a line",
    severity: "info",
    category: "system",
    event: null,
    display: "…4469-ema-crossover.MNQ",
    ticker: null,
    tradeId: null,
    values: null,
    burstCount: 1,
    seq: 0,
    ...over,
  };
}

/**
 * A staging-shaped payload: a boot's `info` lines, a heartbeat, a broker
 * `debug` frame, one `error`, and a second deployment — the mix that decides
 * every default in this file.
 */
const PAYLOAD: WireLogRecord[] = [
  record({ message: "boot: engine started", category: "lifecycle" }),
  record({ message: "boot: 2 deployments enabled", category: "lifecycle" }),
  record({ message: "market hub connected", category: "connection", level: "connection" }),
  record({ message: "heartbeat", category: "heartbeat", level: "heartbeat" }),
  record({ severity: "debug", category: "broker", message: "Tradovate WS: order status=3" }),
  record({
    severity: "error",
    category: "safety",
    level: "error",
    event: "force_close_failed",
    message: "could not force-close",
  }),
  record({ deploymentId: OTHER, display: "…8812-rsi-reversal.MES", message: "second deployment" }),
];

describe("the facet inventory", () => {
  it("enumerates the whole severity and category vocabulary, zeroes included", () => {
    const facets = buildFacets(PAYLOAD, DEFAULT_FACET_STATE);
    expect(facets.severity.map((f) => f.value)).toEqual(["error", "warn", "info", "debug"]);
    expect(facets.severity.find((f) => f.value === "warn")?.count).toBe(0);
    expect(facets.category.map((f) => f.value)).toEqual([
      "trade",
      "order",
      "safety",
      "connection",
      "lifecycle",
      "broker",
      "system",
      "heartbeat",
    ]);
  });

  it("counts every fetched record, including the ones a facet is hiding", () => {
    const facets = buildFacets(PAYLOAD, DEFAULT_FACET_STATE);
    expect(facets.category.find((f) => f.value === "heartbeat")).toMatchObject({
      count: 1,
      enabled: false,
    });
    expect(facets.severity.find((f) => f.value === "debug")).toMatchObject({
      count: 1,
      enabled: false,
    });
  });

  it("lists deployments by display, with the uuid on the tooltip and busiest first", () => {
    const facets = buildFacets(PAYLOAD, DEFAULT_FACET_STATE);
    expect(facets.deployment.map((f) => f.label)).toEqual([
      "…4469-ema-crossover.MNQ",
      "…8812-rsi-reversal.MES",
    ]);
    expect(facets.deployment[0].title).toBe(DEPLOYMENT);
    expect(facets.deployment[0].count).toBe(6);
    for (const option of facets.deployment) expect(option.label).not.toContain(option.value);
  });

  it("upgrades a deployment's label when a later line carries the display", () => {
    const facets = buildFacets(
      [record({ display: null }), record({ display: "…4469-ema-crossover.MNQ" })],
      DEFAULT_FACET_STATE,
    );
    expect(facets.deployment[0].label).toBe("…4469-ema-crossover.MNQ");
  });
});

describe("the defaults", () => {
  it("shows INFO — the default the wrong-diagnosis incident is about", () => {
    const shown = applyFacets(PAYLOAD, DEFAULT_FACET_STATE);
    expect(shown.filter((r) => r.severity === "info").length).toBeGreaterThan(0);
    expect(shown.some((r) => r.message === "boot: engine started")).toBe(true);
  });

  it("hides heartbeat and debug, and nothing else", () => {
    const shown = applyFacets(PAYLOAD, DEFAULT_FACET_STATE);
    expect(shown.some((r) => r.category === "heartbeat")).toBe(false);
    expect(shown.some((r) => r.severity === "debug")).toBe(false);
    expect(shown).toHaveLength(PAYLOAD.length - 2);
  });

  it("shows a deployment that first appears on a later poll", () => {
    const arriving = record({ deploymentId: "brand-new", display: "…1111-macd.MGC" });
    expect(applyFacets([...PAYLOAD, arriving], DEFAULT_FACET_STATE)).toContain(arriving);
  });
});

describe("filtering", () => {
  it("requires every dimension to agree", () => {
    const state: FacetState = toggleFacet(DEFAULT_FACET_STATE, "category", "safety");
    const shown = applyFacets(PAYLOAD, state);
    expect(shown.some((r) => r.category === "safety")).toBe(false);
    expect(shown.some((r) => r.category === "lifecycle")).toBe(true);
  });

  it("filters by deployment on the id, not on the label", () => {
    const state = toggleFacet(DEFAULT_FACET_STATE, "deployment", OTHER);
    expect(applyFacets(PAYLOAD, state).some((r) => r.deploymentId === OTHER)).toBe(false);
  });

  it("shows nothing when a dimension is switched entirely off", () => {
    // From cleared, because `debug` starts off — toggling it from the
    // default would switch it back *on* and leave a row standing.
    let state = clearFacetDimension(DEFAULT_FACET_STATE, "severity");
    for (const value of ["error", "warn", "info", "debug"]) {
      state = toggleFacet(state, "severity", value);
    }
    expect(applyFacets(PAYLOAD, state)).toHaveLength(0);
  });

  it("searches the message, the subject and the event name", () => {
    expect(applyFacets(PAYLOAD, DEFAULT_FACET_STATE, "force-close")).toHaveLength(1);
    expect(applyFacets(PAYLOAD, DEFAULT_FACET_STATE, "force_close_failed")).toHaveLength(1);
    expect(applyFacets(PAYLOAD, DEFAULT_FACET_STATE, "rsi-reversal")).toHaveLength(1);
    expect(applyFacets(PAYLOAD, DEFAULT_FACET_STATE, "  ")).toHaveLength(PAYLOAD.length - 2);
  });

  it("composes the search with the facets rather than overriding them", () => {
    expect(applyFacets(PAYLOAD, DEFAULT_FACET_STATE, "Tradovate WS")).toHaveLength(0);
  });
});

describe("toggling", () => {
  it("returns a fresh state and leaves the old one alone", () => {
    const next = toggleFacet(DEFAULT_FACET_STATE, "severity", "error");
    expect(next.severity.has("error")).toBe(true);
    expect(DEFAULT_FACET_STATE.severity.has("error")).toBe(false);
    expect(toggleFacet(next, "severity", "error").severity.has("error")).toBe(false);
  });

  it("clears a whole dimension back on", () => {
    const cleared = clearFacetDimension(DEFAULT_FACET_STATE, "category");
    expect(applyFacets(PAYLOAD, cleared).some((r) => r.category === "heartbeat")).toBe(true);
    expect(cleared.severity).toBe(DEFAULT_FACET_STATE.severity);
  });
});

/**
 * `?deployment=` — the board's and the drill-in's entry point into `/logs`.
 *
 * It is a scope rather than a facet preset because the facet strip is the
 * Diagnostics lane's control alone; the assertions below are about the two
 * properties that follow from that, plus the empty case, which is the one a
 * link from a row with no lines yet actually hits.
 */
describe("the deployment scope", () => {
  it("keeps one deployment's records and names it by its display, not its id", () => {
    const scope = scopeToDeployments(PAYLOAD, [OTHER]);
    expect(scope?.records).toHaveLength(1);
    expect(scope?.records[0].message).toBe("second deployment");
    expect(scope?.label).toBe("…8812-rsi-reversal.MES");
  });

  it("takes several ids, so a multi-leg drill-in can name every leg it shows", () => {
    const scope = scopeToDeployments(PAYLOAD, [DEPLOYMENT, OTHER]);
    expect(scope?.records).toHaveLength(PAYLOAD.length);
    expect(scope?.label).toBe("…4469-ema-crossover.MNQ · …8812-rsi-reversal.MES");
  });

  it("does not consult the facets — a scope holds on both lanes", () => {
    // Every default-off value survives the scope. Filtering here as well
    // would double-apply on Diagnostics and apply at all on Activity, which
    // renders the whole stream and has no strip to say what it is hiding.
    const scope = scopeToDeployments(PAYLOAD, [DEPLOYMENT]);
    expect(scope?.records.some((r) => r.category === "heartbeat")).toBe(true);
    expect(scope?.records.some((r) => r.severity === "debug")).toBe(true);
  });

  it("answers an id with no lines as an empty scope under its own id", () => {
    const scope = scopeToDeployments(PAYLOAD, ["not-a-deployment-in-this-window"]);
    expect(scope?.records).toEqual([]);
    expect(scope?.label).toBe("not-a-deployment-in-this-window");
  });

  it("falls back to the id for a line that carries no display", () => {
    const bare = [record({ deploymentId: OTHER, display: null, message: "legacy row" })];
    expect(scopeToDeployments(bare, [OTHER])?.label).toBe(OTHER);
  });

  it("is null for no ids, so the viewer branches once instead of matching all", () => {
    expect(scopeToDeployments(PAYLOAD, [])).toBeNull();
  });
});
