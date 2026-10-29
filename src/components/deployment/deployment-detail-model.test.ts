/**
 * The drill-in's decisions.
 *
 * Fixtures come out of the shipped `buildBoard` rather than being written as
 * `BoardDeployment` literals: this module's whole job is to be right about
 * what the adapter produced, so a hand-rolled card would let the two drift
 * and every test would still pass. The identity-chip cases in particular are
 * assertions about `formatDeploymentChips`' output reaching here intact.
 */

import { describe, it, expect } from "vitest";
import { buildBoard, type BoardAccount, type BoardInput } from "@/components/board/board-model";
import {
  CHIPS_DIFFER_BY_ACCOUNT,
  DETACHED_LEG_HISTORY,
  deploymentIdentity,
  describeLegCaveat,
  describeSectionCount,
  splitAccountName,
  describeTruncation,
  formatWinRate,
  historyStats,
  presentDeploymentDetail,
  resolveDeployment,
  selectLegs,
} from "./deployment-detail-model";
import { BOARD_LIST_STALE_WARNING, BOARD_STALE_WARNING } from "@/components/board/board-view";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import type { PnLSummary } from "@/lib/db/trade-types";
import type { Deployment, DeploymentGroup } from "@/lib/trading/domain";

/** Real Topstep account names, quoted from the prefix table's confirmed set
 *  in docs/modules/brokers/topstep.md — `PRAC-` is permitted to auto-trade. */
const ACCOUNT_A: BoardAccount = {
  id: 5001,
  name: "PRAC-V2-100200-90012114",
  broker: "topstep",
  practice: true,
  autoTrade: { permitted: true },
};
const ACCOUNT_B: BoardAccount = {
  id: 5002,
  name: "PRAC-V2-100200-90020038",
  broker: "topstep",
  practice: true,
  autoTrade: { permitted: true },
};

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep-1",
    strategyKey: "ema-crossover",
    accountId: ACCOUNT_A.id,
    ticker: "/MNQ",
    contractId: null,
    status: "Active",
    paramValues: { cooldownSeconds: 30 },
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T12:00:00.000Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: "parent-1",
    enabledSnapshot: null,
    ...overrides,
  };
}

function group(overrides: Partial<DeploymentGroup> = {}): DeploymentGroup {
  return {
    id: "grp-1",
    name: null,
    strategyKey: "ema-crossover",
    paramValues: { cooldownSeconds: 30 },
    ticker: "/MNQ",
    contractId: null,
    enabled: true,
    bookId: null,
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T12:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function emptyPnl(): PnLBreakdown {
  return {
    realized: 0,
    unrealized: 0,
    fees: 0,
    total: 0,
    closedCount: 0,
    hasOpenPosition: false,
  };
}

/** The brand is asserted visibly here, exactly as `board-model.test.ts` does
 *  — what it takes away is the *silent* wiring in a component. */
function selector(answer: (id: string) => PnLBreakdown | null): BoardInput["sessionPnl"] {
  return answer as BoardInput["sessionPnl"];
}

/** The parent of the default `deployment()` fixture. Every leg has one. */
const PARENT: DeploymentGroup = {
  id: "parent-1",
  name: null,
  strategyKey: "ema-crossover",
  paramValues: { cooldownSeconds: 30 },
  ticker: "/MNQ",
  contractId: null,
  enabled: true,
  bookId: null,
  createdAt: "2026-09-03T12:00:00.000Z",
  updatedAt: "2026-09-03T12:00:00.000Z",
  deletedAt: null,
};

function build(overrides: Partial<BoardInput> = {}) {
  return buildBoard({
    deployments: [],
    groups: [PARENT],
    accounts: [ACCOUNT_A, ACCOUNT_B],
    trades: [],
    strategy: (key) =>
      key === "ema-crossover"
        ? {
            name: "EMA Crossover",
            timeframe: "5m",
            session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
          }
        : null,
    sessionPnl: selector(() => emptyPnl()),
    regime: () => null,
    risk: () => ({ kind: "pending" }) as const,
    ...overrides,
  });
}

function summary(overrides: Partial<PnLSummary> = {}): PnLSummary {
  return {
    totalTrades: 0,
    closedTrades: 0,
    openTrades: 0,
    winCount: 0,
    lossCount: 0,
    totalPnlDollars: 0,
    totalFeesDollars: 0,
    ...overrides,
  };
}

describe("resolveDeployment — one page per deployment, reachable by either id", () => {
  it("finds a one-leg deployment through its leg id, preselecting that account", () => {
    // A one-leg deployment's card id used to *be* its leg id, so this landed
    // on the card-lookup arm. It now has an id of its own and the leg arm is
    // what answers — which is the same arm every link built from a leg takes.
    const board = build({ deployments: [deployment()] });
    const found = resolveDeployment(board, "dep-1");

    expect(found?.card.id).toBe("parent-1");
    expect(found?.accountId).toBe(ACCOUNT_A.id);
  });

  it("finds a group by its card id, with no account preselected", () => {
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
    });
    const found = resolveDeployment(board, "grp-1");

    expect(found?.card.id).toBe("grp-1");
    expect(found?.accountId).toBeNull();
  });

  it("resolves a leg id to its card and preselects that leg's account", () => {
    // The board's ▸ is on a leg row, so the link it builds names the leg —
    // and a leg of a group has an id the card does not carry.
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
    });
    const found = resolveDeployment(board, "leg-b");

    expect(found?.card.id).toBe("grp-1");
    expect(found?.accountId).toBe(ACCOUNT_B.id);
  });

  it("answers null for an id no live deployment carries", () => {
    const board = build({ deployments: [deployment()] });

    expect(resolveDeployment(board, "dep-gone")).toBeNull();
  });

  it("answers null for a soft-deleted row rather than resurrecting it", () => {
    const board = build({
      deployments: [deployment({ deletedAt: "2026-09-03T13:00:00.000Z" })],
    });

    expect(resolveDeployment(board, "dep-1")).toBeNull();
  });
});

describe("presentDeploymentDetail — gone, not yet, and could not say", () => {
  const found = () => {
    const board = build({ deployments: [deployment()] });
    return resolveDeployment(board, "dep-1");
  };

  it("renders the deployment when both channels are healthy", () => {
    const shown = presentDeploymentDetail({
      connection: "connected",
      deployments: "ready",
      found: found(),
    });

    expect(shown.body.kind).toBe("deployment");
    expect(shown.warning).toBeNull();
  });

  it("says missing only once both channels have answered", () => {
    expect(
      presentDeploymentDetail({ connection: "connected", deployments: "ready", found: null }).body
        .kind,
    ).toBe("missing");
  });

  it("says loading, not missing, while the store is still reading", () => {
    // A deployment that has not arrived yet is not a deployment that was
    // deleted, and only one of those means anything is over.
    for (const state of ["idle", "loading"] as const) {
      expect(
        presentDeploymentDetail({ connection: "connected", deployments: state, found: null }).body
          .kind,
      ).toBe("loading");
    }
    expect(
      presentDeploymentDetail({ connection: "connecting", deployments: "ready", found: null }).body
        .kind,
    ).toBe("loading");
  });

  it("says unavailable, not missing, when a channel broke", () => {
    expect(
      presentDeploymentDetail({ connection: "error", deployments: "ready", found: null }).body.kind,
    ).toBe("unavailable");
    expect(
      presentDeploymentDetail({ connection: "connected", deployments: "failed", found: null }).body
        .kind,
    ).toBe("unavailable");
  });

  it("keeps a resolved deployment on screen behind a stale banner", () => {
    const shown = presentDeploymentDetail({
      connection: "connected",
      deployments: "failed",
      found: found(),
    });

    expect(shown.body.kind).toBe("deployment");
    expect(shown.warning).toBe(BOARD_LIST_STALE_WARNING);
  });

  it("names the connection only when the connection is what broke", () => {
    const shown = presentDeploymentDetail({
      connection: "error",
      deployments: "ready",
      found: found(),
    });

    expect(shown.warning).toBe(BOARD_STALE_WARNING);
  });
});

describe("selectLegs — the per-account filter", () => {
  const board = () =>
    build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
    });

  it("covers every leg when no account is selected", () => {
    const selection = selectLegs(board()[0], null);

    expect(selection.legs.map((l) => l.id)).toEqual(["leg-a", "leg-b"]);
    expect(selection.accountId).toBeNull();
  });

  it("narrows to one account's legs", () => {
    const selection = selectLegs(board()[0], ACCOUNT_B.id);

    expect(selection.legs.map((l) => l.id)).toEqual(["leg-b"]);
    expect(selection.accountId).toBe(ACCOUNT_B.id);
  });

  it("falls back to all accounts when the selected one is no longer a leg", () => {
    // Removing a leg from another tab is ordinary. An empty page whose filter
    // names an account the deployment does not have reads as a broken query.
    const selection = selectLegs(board()[0], 9999);

    expect(selection.legs.map((l) => l.id)).toEqual(["leg-a", "leg-b"]);
    expect(selection.accountId).toBeNull();
  });
});

describe("deploymentIdentity — the chip row, and when it refuses to speak", () => {
  it("renders the chip vocabulary for a single-leg deployment", () => {
    const card = build({ deployments: [deployment()] })[0];

    expect(deploymentIdentity(card, card.legs).chips).toBe("CD: 30s");
  });

  it("prefixes the strategy key only when the operator named the deployment", () => {
    const named = build({
      groups: [{ ...PARENT, name: "Morning MNQ" }],
      deployments: [deployment()],
    })[0];
    const unnamed = build({ deployments: [deployment()] })[0];

    expect(deploymentIdentity(named, named.legs).chips).toBe(
      "ema-crossover · CD: 30s",
    );
    expect(deploymentIdentity(unnamed, unnamed.legs).chips).toBe("CD: 30s");
  });

  it("keeps the prefix when a custom name happens to equal the strategy key", () => {
    // The input is `hasCustomName`, not a string compare — otherwise an
    // operator naming a deployment after its strategy loses the prefix on a
    // coincidence.
    const card = build({
      groups: [{ ...PARENT, name: "ema-crossover" }],
      deployments: [deployment()],
    })[0];

    expect(card.hasCustomName).toBe(true);
    expect(deploymentIdentity(card, card.legs).chips).toBe(
      "ema-crossover · CD: 30s",
    );
  });

  it("carries the optional gate chips through", () => {
    const card = build({
      groups: [{ ...PARENT, paramValues: { size: 2 } }],
      deployments: [
        deployment({
          paramValues: {
            stopLossOverrideTicks: 20,
            riskRewardRatio: 2,
            cooldownSeconds: 30,
            dailyMaxLossUsd: 500,
            dailyPnlIncludeUnrealized: true,
          },
        }),
      ],
    })[0];

    // Every retired key is in the blob and reaches no chip: the bracket ones,
    // and the daily gate, whose number is the account's now.
    expect(deploymentIdentity(card, card.legs).chips).toBe("CD: 30s");
  });

  it("refuses one row for a deployment whose legs disagree", () => {
    // Nothing on the chip row is per leg today — `Size` was the last thing
    // that could differ and it went with `sizeOverride` — so this drives the
    // rule through the strings the fold actually compares. The check is what
    // makes the next per-leg field safe to add.
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
    });
    const legs = board[0].legs.map((leg, i) =>
      i === 0 ? leg : { ...leg, chips: `${leg.chips} · CD: 30s` },
    );
    const identity = deploymentIdentity(board[0], legs);

    expect(identity.chips).toBeNull();
    expect(identity.differsByAccount).toBe(true);
    expect(CHIPS_DIFFER_BY_ACCOUNT).toContain("Pick an account");
  });

  it("speaks for a group whose legs agree", () => {
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
    });

    expect(deploymentIdentity(board[0], board[0].legs).chips).toBe("CD: 30s");
    expect(deploymentIdentity(board[0], board[0].legs).differsByAccount).toBe(false);
  });

  it("states no contract count, on a broken row as on a healthy one", () => {
    // A leg whose parent is gone. It used to print `Size —`; there is no
    // size question to answer at all now, and inventing one would be the
    // defect that em-dash existed to avoid.
    const board = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    });

    expect(deploymentIdentity(board[0], board[0].legs).chips).toBe("CD: 30s");
  });

  it("says nothing at all for a card with no legs", () => {
    const identity = deploymentIdentity({ strategyKey: "ema-crossover", hasCustomName: false }, []);

    expect(identity.chips).toBeNull();
    expect(identity.differsByAccount).toBe(false);
  });
});

describe("historyStats — all-time, and only from the server's own aggregate", () => {
  it("reads every field off the summary", () => {
    const stats = historyStats(
      summary({
        totalTrades: 42,
        closedTrades: 40,
        openTrades: 2,
        winCount: 24,
        lossCount: 16,
        totalPnlDollars: 1234.5,
        totalFeesDollars: 82.4,
      }),
    );

    expect(stats).toEqual({
      totalPnl: 1234.5,
      fees: 82.4,
      closed: 40,
      open: 2,
      wins: 24,
      losses: 16,
      winRate: 0.6,
    });
  });

  it("has no win rate before anything has closed", () => {
    // `0%` on a deployment that has never traded says it loses every time.
    expect(historyStats(summary())?.winRate).toBeNull();
    expect(formatWinRate(null)).toBe("—");
  });

  it("takes the rate over decided trades, so scratches do not dilute it", () => {
    const stats = historyStats(
      summary({ closedTrades: 10, winCount: 6, lossCount: 2 }),
    );

    expect(stats?.winRate).toBe(0.75);
    expect(formatWinRate(stats?.winRate ?? null)).toBe("75%");
  });

  it("answers null before the summary arrives", () => {
    expect(historyStats(null)).toBeNull();
  });
});

describe("describeTruncation — the table's cap against the summary's total", () => {
  it("says nothing when the list holds everything", () => {
    expect(
      describeTruncation({ summary: summary({ totalTrades: 40 }), loadedCount: 40 }),
    ).toBeNull();
  });

  it("names both numbers when the list is capped", () => {
    const line = describeTruncation({ summary: summary({ totalTrades: 340 }), loadedCount: 200 });

    expect(line).toContain("200");
    expect(line).toContain("340");
  });

  it("says nothing before the summary arrives", () => {
    expect(describeTruncation({ summary: null, loadedCount: 200 })).toBeNull();
  });
});

describe("describeSectionCount — the server's count, and how much of it is shown", () => {
  it("prints the server's number when the list holds all of it", () => {
    expect(describeSectionCount({ total: 3, shown: 3 })).toBe("(3)");
  });

  it("names both numbers when the list is capped below the server's count", () => {
    // The open row outside the 200-row window is the whole defect: the bar
    // used to read "No Open Position" under a strip printing `Open 1`.
    expect(describeSectionCount({ total: 1, shown: 0 })).toBe("(0 of 1)");
    expect(describeSectionCount({ total: 340, shown: 200 })).toBe("(200 of 340)");
  });

  it("renders `…` rather than a zero before the summary arrives", () => {
    expect(describeSectionCount({ total: null, shown: 0 })).toBe("…");
  });

  it("falls back to what it can see when the summary is absent but rows are not", () => {
    expect(describeSectionCount({ total: null, shown: 4 })).toBe("(4)");
  });
});

describe("splitAccountName — the end of the name is the part that identifies it", () => {
  it("keeps the suffix that tells two legs of one deployment apart", () => {
    // The real failure: these two share sixteen characters, so an
    // end-truncating column renders both as `PRAC-V2-100200…`.
    const a = splitAccountName("PRAC-V2-100200-90012114");
    const b = splitAccountName("PRAC-V2-100200-90020038");
    expect(a.tail).toBe("-90012114");
    expect(b.tail).toBe("-90020038");
    expect(a.tail).not.toBe(b.tail);
  });

  it("rejoins to the original name", () => {
    for (const name of ["PRAC-V2-100200-90012114", "Sim101", "a-b-c", "-lead", "trail-"]) {
      const { head, tail } = splitAccountName(name);
      expect(head + tail).toBe(name);
    }
  });

  it("gives a name with no separator an empty tail, so it truncates the ordinary way", () => {
    expect(splitAccountName("Sim101")).toEqual({ head: "Sim101", tail: "" });
  });

  it("does not split on a leading separator, which would leave the whole name as the tail", () => {
    // `lastIndexOf` at 0 is the degenerate case: an empty head means the
    // `shrink-0` span carries everything and the cell stops truncating at all.
    expect(splitAccountName("-90012114")).toEqual({ head: "-90012114", tail: "" });
  });
});

describe("describeLegCaveat — a detached leg's history is still its history", () => {
  it("warns on a detached leg without hiding its rows", () => {
    expect(describeLegCaveat({ detached: true })).toBe(DETACHED_LEG_HISTORY);
  });

  it("says nothing about an ordinary leg", () => {
    expect(describeLegCaveat({ detached: false })).toBeNull();
  });
});
