/**
 * The editor's decisions, tested without a DOM — phase 5 of ui-rework.md.
 *
 * Two of these guard a rule the *server* enforces with a 400 or a 409, so a
 * regression here is a save that fails at the round trip rather than at the
 * field. The `groupPatchFrom` key census is the sharpest: `PATCH
 * /api/groups/[id]` rejects the whole request if `ticker` or `strategyKey` is
 * merely *present* in the body, so a form that helpfully sent them unchanged
 * would break every save while looking correct.
 */

import { describe, it, expect } from "vitest";
import {
  buildSavePlan,
  describeConflict,
  draftFrom,
  groupPatchFrom,
  isDirty,
  isLastLeg,
  readConflict,
  type EditorDraft,
} from "./deployment-editor-model";
import type { Deployment, DeploymentGroup, TickerSymbol } from "@/lib/trading/domain";

const TICKER = "/MNQ" as TickerSymbol;

function group(over: Partial<DeploymentGroup> = {}): DeploymentGroup {
  return {
    id: "grp-1",
    name: "Morning fade",
    strategyKey: "ema-crossover",
    paramValues: { size: 2, mainSession: { start: "09:30", end: "16:00", timezone: "America/New_York" } },
    ticker: TICKER,
    contractId: null,
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    ...over,
  } as DeploymentGroup;
}

function leg(id: string, accountId: number): Deployment {
  return { id, accountId, strategyKey: "ema-crossover", ticker: TICKER, status: "Active" } as Deployment;
}

describe("draftFrom", () => {
  it("seeds the name, the parent's params and the account set", () => {
    const g = group();
    const legs = [leg("a", 1), leg("b", 2)];
    expect(draftFrom(g, legs)).toEqual({
      name: "Morning fade",
      paramValues: g.paramValues,
      accountIds: new Set([1, 2]),
    });
  });

  it("renders a nameless deployment as an empty field, not the string 'null'", () => {
    expect(draftFrom(group({ name: null }), []).name).toBe("");
  });

  it("copies paramValues rather than aliasing the row", () => {
    // The form mutates the draft on every keystroke; aliasing would edit the
    // row the dirty check compares against, so nothing would ever look dirty.
    const g = group();
    const draft = draftFrom(g, []);
    (draft.paramValues as Record<string, unknown>).size = 99;
    expect((g.paramValues as Record<string, unknown>).size).toBe(2);
  });
});

/** An otherwise-empty draft, for the name-normalisation cases. */
function bareDraft(name: string): EditorDraft {
  return { name, paramValues: {}, accountIds: new Set() };
}

describe("groupPatchFrom", () => {
  it("sends exactly `name` and `paramValues` — never ticker or strategyKey", () => {
    // The route 400s on their mere presence, so this is a key census rather
    // than a value assertion.
    const patch = groupPatchFrom(draftFrom(group(), []));
    expect(Object.keys(patch).sort()).toEqual(["name", "paramValues"]);
  });

  it("normalises a blank name to null so the row falls back to the strategy name", () => {
    expect(groupPatchFrom(bareDraft("   ")).name).toBeNull();
    expect(groupPatchFrom(bareDraft("")).name).toBeNull();
  });

  it("trims a real name rather than storing the operator's whitespace", () => {
    expect(groupPatchFrom(bareDraft("  Fade  ")).name).toBe("Fade");
  });
});

describe("buildSavePlan", () => {
  const g = group();
  const legs = [leg("a", 1), leg("b", 2)];
  const base = () => draftFrom(g, legs);

  it("sends nothing structural for an untouched draft", () => {
    const plan = buildSavePlan(base(), g, legs);
    expect(plan.addLegs).toEqual([]);
    expect(plan.removeLegIds).toEqual([]);
  });

  it("adds a checked account that is not a leg yet", () => {
    const draft = base();
    draft.accountIds.add(7);
    expect(buildSavePlan(draft, g, legs).addLegs).toEqual([{ accountId: 7 }]);
  });

  it("removes a leg whose account was unchecked, by leg id", () => {
    const draft = base();
    draft.accountIds.delete(2);
    expect(buildSavePlan(draft, g, legs).removeLegIds).toEqual(["b"]);
  });

  it("removes a leg another tab added between load and save", () => {
    // The plan is diffed against the rows, so an account the draft has never
    // checked reads as a removal — and the operator sees it as a removal in
    // the picker before pressing Save.
    const withNew = [...legs, leg("new", 9)];
    expect(buildSavePlan(base(), g, withNew).removeLegIds).toEqual(["new"]);
  });
});

describe("isDirty", () => {
  it("is false for an untouched draft", () => {
    const g = group();
    const legs = [leg("a", 1)];
    expect(isDirty(draftFrom(g, legs), g, legs)).toBe(false);
  });

  it("is false when the only edit is whitespace around the name", () => {
    // Save is disabled on !isDirty, so this has to agree with what
    // `groupPatchFrom` would actually send — which trims.
    const g = group();
    expect(isDirty({ ...draftFrom(g, []), name: "  Morning fade  " }, g, [])).toBe(false);
  });

  it("sees a param change", () => {
    const g = group();
    expect(isDirty({ ...draftFrom(g, []), paramValues: { size: 5 } }, g, [])).toBe(true);
  });

  it("sees a leg added and a leg removed", () => {
    const g = group();
    const legs = [leg("a", 1), leg("b", 2)];
    const added = draftFrom(g, legs);
    added.accountIds.add(7);
    expect(isDirty(added, g, legs)).toBe(true);
    const removed = draftFrom(g, legs);
    removed.accountIds.delete(2);
    expect(isDirty(removed, g, legs)).toBe(true);
  });

  it("sees a name cleared to nothing", () => {
    const g = group();
    expect(isDirty({ ...draftFrom(g, []), name: "" }, g, [])).toBe(true);
  });
});

describe("isLastLeg", () => {
  it("refuses removal at one leg and allows it at two", () => {
    expect(isLastLeg([leg("a", 1)])).toBe(true);
    expect(isLastLeg([leg("a", 1), leg("b", 2)])).toBe(false);
  });

  it("is true for an empty list rather than throwing", () => {
    // Reachable: a concurrent remove in another tab between load and render.
    expect(isLastLeg([])).toBe(true);
  });
});

describe("readConflict", () => {
  /** The body `PATCH /api/groups/[id]` actually returns, field for field. */
  const body = {
    partialConflict: true,
    error: "Conflict on 1 of 2 accounts.",
    perLeg: [
      { legId: "a", accountId: 1, conflict: { id: "other", name: "Scalper", strategyKey: "orb" } },
      { legId: "b", accountId: 2, conflict: null },
    ],
  };

  it("keeps only the legs that actually conflict, and counts the rest", () => {
    expect(readConflict(body)).toEqual({
      blocked: [body.perLeg[0]],
      totalLegs: 2,
    });
  });

  it("returns null for a body that is not a partial conflict", () => {
    // An ordinary 409 has to fall through to the generic error path — an
    // empty conflict panel would claim nothing is wrong on a failed save.
    expect(readConflict({ error: "Update failed" })).toBeNull();
    expect(readConflict({ partialConflict: true })).toBeNull();
    expect(readConflict(null)).toBeNull();
    expect(readConflict("nope")).toBeNull();
  });

  it("returns null when the server reports a conflict with nothing blocked", () => {
    expect(readConflict({ partialConflict: true, perLeg: [{ legId: "a", accountId: 1, conflict: null }] })).toBeNull();
  });
});

describe("describeConflict", () => {
  it("agrees with itself about singular and plural", () => {
    const one = describeConflict({ blocked: [{ legId: "a", accountId: 1, conflict: null }], totalLegs: 2 });
    expect(one).toContain("1 of 2 account.");
    const two = describeConflict({
      blocked: [
        { legId: "a", accountId: 1, conflict: null },
        { legId: "b", accountId: 2, conflict: null },
      ],
      totalLegs: 3,
    });
    expect(two).toContain("2 of 3 accounts.");
  });

  it("states what applying anyway does, not just that something is wrong", () => {
    const s = describeConflict({ blocked: [{ legId: "a", accountId: 1, conflict: null }], totalLegs: 1 });
    expect(s).toMatch(/both running on the same account/i);
  });
});
