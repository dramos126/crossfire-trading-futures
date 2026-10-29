/**
 * The board's view model. These tests exercise the shipped adapter and the
 * shipped size resolver — no local restatement of either, because the whole
 * point of the module is that the board never re-derives what it renders.
 *
 * The shapes covered are the ones that exist today: a standalone, a group
 * with two legs, a per-leg size override, a leg mid-close, an orphaned leg,
 * and a row whose `name` is null. After the model change the inputs collapse
 * to one shape and these cases collapse with them — the assertions on the
 * *output* are what must still hold.
 *
 * **And both groupings, since 2026-09-15.** A book's derived rows fold into
 * one card per `(account, ticker)` when the caller asks; every row with no
 * `book_id` groups by its parent beside them, unchanged, which is what the
 * hand-made cases above keep pinning.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildBoard,
  type BoardAccount,
  type BoardAccountStatus,
  type BoardInput,
  type BoardLeg,
  type BoardLegRisk,
  type BoardTrade,
} from "./board-model";
import {
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import { PLAYBOOK_NOT_IN_BUILD } from "@/lib/trading/strategies/prod-playbooks";
import type { Deployment, DeploymentGroup } from "@/lib/trading/domain";
import type { ParamValues } from "@/lib/trading/strategy-types";

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
    paramValues: { size: 1 },
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
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
    paramValues: { size: 3 },
    ticker: "/MNQ",
    contractId: null,
    enabled: true,
    // Hand-made by default, which is what every row on an install that has
    // never opened a book reads as. A derived-row test passes `bookId`.
    bookId: null,
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function pnl(overrides: Partial<PnLBreakdown> = {}): PnLBreakdown {
  return {
    realized: 0,
    unrealized: 0,
    fees: 0,
    total: 0,
    closedCount: 0,
    hasOpenPosition: false,
    ...overrides,
  };
}

/**
 * A fixture selector, branded.
 *
 * `BoardInput.sessionPnl` is a branded type whose one producer in `src/` is
 * `boardSessionPnl` — which exists to stop a component wiring
 * `useLivePnL(...).deployment` straight in and reporting every detached and
 * practice-filtered account as flat. That wrapper is tested against the real
 * selector in `board-view.test.ts`; what *this* file tests is the fold above
 * it, so the brand is asserted here rather than routed around. The assertion
 * is visible and deliberate, which is exactly the thing the brand takes away
 * from production code.
 */
function selector(answer: (id: string) => PnLBreakdown | null): BoardInput["sessionPnl"] {
  return answer as BoardInput["sessionPnl"];
}

/** The parent the default `deployment()` fixture belongs to. Every leg has
 *  one, so the default input carries it; a test about a *multi*-leg
 *  deployment passes `groups: [group()]` and points its legs at `grp-1`. */
const PARENT: DeploymentGroup = {
  id: "parent-1",
  name: null,
  strategyKey: "ema-crossover",
  paramValues: { size: 1 },
  ticker: "/MNQ",
  contractId: null,
  enabled: true,
  bookId: null,
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
  deletedAt: null,
};

function build(overrides: Partial<BoardInput> = {}): ReturnType<typeof buildBoard> {
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
    sessionPnl: selector(() => pnl()),
    regime: () => null,
    risk: () => PENDING_RISK,
    ...overrides,
  });
}

/** The arm that claims nothing. `boardRisk` is what decides between the five
 *  and it is tested against the shipped resolver in `board-view.test.ts`;
 *  what this file asserts is where the answer lands. */
const PENDING_RISK: BoardLegRisk = { kind: "pending" };

describe("buildBoard — one row shape", () => {
  it("renders a one-leg deployment carrying its parent's id", () => {
    const board = build({ deployments: [deployment()] });

    expect(board).toHaveLength(1);
    expect(board[0].id).toBe("parent-1");
    expect(board[0].legs.map((l) => l.id)).toEqual(["dep-1"]);
    expect(board[0].legs[0].accountName).toBe(ACCOUNT_A.name);
  });

  it("renders a group's two legs as one deployment, ordered by account", () => {
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
      ],
    });

    expect(board).toHaveLength(1);
    expect(board[0].id).toBe("grp-1");
    expect(board[0].legs.map((l) => l.id)).toEqual(["leg-a", "leg-b"]);
  });

  it("keeps a leg whose group row is gone, as its own one-leg deployment", () => {
    // A live row missing from the board is the failure the board exists to
    // prevent, so a half-finished group cascade renders rather than vanishing.
    const board = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    });

    expect(board).toHaveLength(1);
    expect(board[0].id).toBe("orphan-leg");
    expect(board[0].armed).toBe(false);
  });

  it("excludes soft-deleted and tombstoned rows", () => {
    const board = build({
      deployments: [
        deployment({ id: "trashed", deletedAt: "2026-09-02T13:00:00.000Z" }),
        deployment({
          id: "retired",
          deletedAt: "2026-09-02T13:00:00.000Z",
          tombstonedAt: "2026-09-02T13:05:00.000Z",
        }),
      ],
    });

    expect(board).toEqual([]);
  });

  it("orders deployments by name, then by id", () => {
    const board = build({
      groups: [
        { ...PARENT, id: "b", name: "ORB — NY" },
        { ...PARENT, id: "a", name: "ORB — NY" },
        { ...PARENT, id: "c", name: "Anti-Trend" },
      ],
      deployments: [
        deployment({ id: "leg-b", groupId: "b" }),
        deployment({ id: "leg-a", groupId: "a" }),
        deployment({ id: "leg-c", groupId: "c" }),
      ],
    });

    expect(board.map((d) => d.id)).toEqual(["c", "a", "b"]);
  });
});

describe("buildBoard — the title is `name ?? strategy display name`", () => {
  // The name is the parent's — a leg has an account and a size override and
  // nothing else the card's title could come from.
  const cases: Array<{ what: string; parent: Partial<DeploymentGroup>; expected: string }> = [
    { what: "an explicit name wins", parent: { name: "ORB — NY" }, expected: "ORB — NY" },
    { what: "a null name falls back to the strategy", parent: { name: null }, expected: "EMA Crossover" },
    {
      what: "an unknown strategy falls back to its key",
      parent: { name: null, strategyKey: "deleted-strategy" },
      expected: "deleted-strategy",
    },
  ];

  for (const { what, parent, expected } of cases) {
    it(what, () => {
      const board = build({
        groups: [{ ...PARENT, ...parent }],
        deployments: [deployment()],
      });
      expect(board[0].name).toBe(expected);
    });
  }

  it("takes the group's name and strategy for a grouped deployment", () => {
    const board = build({
      groups: [group({ name: "ORB — three accounts" })],
      deployments: [deployment({ groupId: "grp-1" })],
    });

    expect(board[0].name).toBe("ORB — three accounts");
  });

  it("reports whether the name is the operator's own, separately from the name", () => {
    // The identity subline's strategy-key prefix keys on this rather than on
    // `name !== strategyKey`, so an operator naming a deployment after its
    // strategy does not lose the prefix on a string coincidence.
    const named = (name: string | null) =>
      build({ groups: [{ ...PARENT, name }], deployments: [deployment()] })[0].hasCustomName;

    expect(named(null)).toBe(false);
    expect(named("ORB — NY")).toBe(true);
    expect(named("ema-crossover")).toBe(true);
  });
});

describe("buildBoard — the identity chip row", () => {
  it("carries the full chip vocabulary per leg", () => {
    const board = build({
      groups: [{ ...PARENT, paramValues: { size: 2 } }],
      deployments: [
        deployment({
          paramValues: {
            stopLossOverrideTicks: 20,
            riskRewardRatio: 2,
            cooldownSeconds: 30,
            dailyMaxProfitUsd: 750,
          },
        }),
      ],
    });

    // Every retired key is in the blob and reaches no chip: the bracket three,
    // and the daily gate, which is the account's now.
    expect(board[0].legs[0].chips).toBe("CD: 30s");
  });

  it("states no contract count, because a deployment no longer has one", () => {
    // The risk sizer answers a count per entry from the account's budget and
    // that signal's stop, so a number here would be invented. A parent
    // carrying a stale `size` param must not resurrect it.
    const board = build({
      groups: [group()],
      deployments: [deployment({ id: "leg-a", groupId: "grp-1", paramValues: { size: 1 } })],
    });

    expect(board[0].legs[0].chips).not.toContain("Size");
    expect(board[0].legs[0].chips).not.toContain("×");
  });
});

describe("buildBoard — the status chip comes from the shared ladder, on prod", () => {
  // Two rungs of this ladder — the `no-auto-trade` chip and the
  // `autoTradeRefused` flag — ask `autoTradeVerdict`, which is env-aware.
  // The fixtures here answer the same on either branch (a `PRAC-` account is
  // permitted, a funded-shaped name is refused as live), so the environment
  // is pinned rather than changed: an unpinned case asserts against whichever
  // branch the runner landed on, and the board is the surface an operator
  // reads a refusal off.
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cases: Array<{ what: string; row: Partial<Deployment>; kind: string; tone: string }> = [
    { what: "an active leg is flat", row: {}, kind: "flat", tone: "muted" },
    { what: "a paused leg", row: { status: "Paused" }, kind: "paused", tone: "muted" },
    { what: "a leg mid-pause", row: { status: "Pausing" }, kind: "pausing", tone: "warn" },
    { what: "a leg mid-destroy", row: { status: "Destroying" }, kind: "destroying", tone: "warn" },
  ];

  for (const { what, row, kind, tone } of cases) {
    it(`${what} reads ${kind}`, () => {
      const leg = build({ deployments: [deployment(row)] })[0].legs[0];
      expect(leg.chip).toMatchObject({ kind, tone });
      // The lifecycle status survives beside the chip: `Pausing` is what the
      // pause/resume affordance goes inert on, and the chip does not say so.
      expect(leg.status).toBe(row.status ?? "Active");
    });
  }

  it("renders an orphaned leg as detached rather than hiding it", () => {
    // Detached stops being a tab: the row belongs on the board, pointing at
    // an account the catalogue no longer holds.
    const board = build({
      accounts: [],
      deployments: [
        deployment({ status: "Paused", orphanedAt: "2026-09-02T13:00:00.000Z", orphanReason: "account_missing" }),
      ],
    });

    expect(board).toHaveLength(1);
    expect(board[0].legs[0]).toMatchObject({
      detached: true,
      orphanReason: "account_missing",
      accountName: "Account 5001",
      chip: { kind: "detached", tone: "danger" },
    });
  });

  it("stamps a live Topstep account no-auto-trade, carrying the refusal verbatim", () => {
    // The board is a fourth surface for the live-account block, and a
    // deployment the engine refuses to run must not render as armed and
    // waiting. `reason` is compared against the exported constant rather than
    // a quoted string — ui/copy.md rule 4 is that no surface rewords it.
    //
    // Invented name, and deliberately: topstep.md's prefix table records
    // `PRAC-V2-…`, `50KTC-V2-…` and `EXPRESS-V2-CT-…` as observed, and **no
    // funded account name has ever been seen** — a name matching none of the
    // three permitted prefixes is exactly what `classifyAccount` calls LIVE.
    const live: BoardAccount = {
      id: 5003,
      name: "FUNDED-100200-11111111",
      broker: "topstep",
      practice: false,
      autoTrade: { permitted: false, reason: LIVE_ACCOUNT_REFUSAL },
    };
    const board = build({
      accounts: [live],
      deployments: [deployment({ accountId: live.id })],
    });

    expect(board[0].legs[0].chip).toEqual({
      kind: "no-auto-trade",
      tone: "danger",
      reason: LIVE_ACCOUNT_REFUSAL,
    });
    // The operator's own switch is still on: the row is refused by policy
    // rather than paused, and ⏸ has to still be offered so they can turn it
    // off. `armed` says the same here because the engine gate the board
    // mirrors does not consult the block either — the refusal is a rung on
    // the chip, not an input to these two.
    expect(board[0].switchOn).toBe(true);
    expect(board[0].armed).toBe(true);
    // …and `autoTradeRefused` is the field that keeps the leg's dot from
    // claiming otherwise. `armed` is deliberately true here, so the dot
    // rendered green beside this red chip until the flag existed.
    expect(board[0].legs[0].autoTradeRefused).toBe(true);
  });

  it("marks a leg the block refuses even when a higher rung owns the chip", () => {
    // A detached leg: `chip.kind` is `detached`, because that rung outranks
    // the refusal — and its account is gone from the catalogue, so the
    // verdict beneath is UNVERIFIED. Reading the chip would have missed it;
    // the field asks the predicate.
    const board = build({
      accounts: [],
      deployments: [
        deployment({ orphanedAt: "2026-09-03T13:00:00.000Z", orphanReason: "account_missing" }),
      ],
    });

    expect(board[0].legs[0].chip.kind).toBe("detached");
    expect(board[0].legs[0].autoTradeRefused).toBe(true);
  });

  it("does not mark a permitted practice leg as refused", () => {
    const board = build({ deployments: [deployment()] });

    expect(board[0].legs[0].autoTradeRefused).toBe(false);
  });

  it("fails closed on an account the catalogue cannot vouch for", () => {
    // Not detached — `orphanReason` is null — just absent from the catalogue
    // the page holds. `null` is the fail-closed input to the shared ladder,
    // not a missing argument.
    const board = build({
      accounts: [],
      deployments: [deployment()],
    });

    expect(board[0].legs[0].chip).toEqual({
      kind: "no-auto-trade",
      tone: "danger",
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
  });

  it("A38 — renders the server's verdict off the row, not one recomputed from the name", () => {
    // The unseeded `account_brokers` row: the account is in `/api/accounts`
    // and its name is a practice name, but the server refuses it as
    // unverified. Recomputing from the name read Flat; the field reads the
    // refusal the engine is applying.
    const unseeded: BoardAccount = {
      ...ACCOUNT_A,
      autoTrade: { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL },
    };
    const board = build({ accounts: [unseeded], deployments: [deployment()] });

    expect(board[0].legs[0].chip).toEqual({
      kind: "no-auto-trade",
      tone: "danger",
      reason: UNVERIFIED_ACCOUNT_REFUSAL,
    });
    expect(board[0].legs[0].autoTradeRefused).toBe(true);
  });

  it("A38 — no client file imports or calls autoTradeVerdict", () => {
    // One authority: the server reports the verdict on each `/api/accounts`
    // and `/api/accounts/risk` row and the client reads the field. A client
    // call would be a second reading that cannot see an unseeded catalog row.
    // An import under any local name counts, and so do `"use client"` files
    // under src/app/; server routes there are gates and ask the predicate.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const reaches = (src: string) =>
      /\bautoTradeVerdict\s*\(/.test(src) ||
      /import\s*(?:type\s+)?\{[^}]*\bautoTradeVerdict\b[^}]*\}\s*from/.test(src);
    const scanned: string[] = [];
    const callers: string[] = [];
    const walk = (dir: string, clientOnly: boolean) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full, clientOnly);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = readFileSync(full, "utf8");
          if (clientOnly && !/^\s*["']use client["']/.test(src)) continue;
          scanned.push(full);
          if (reaches(src)) callers.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, "components"), false);
    walk(path.join(root, "lib/hooks"), false);
    walk(path.join(root, "app"), true);

    expect(reaches('import { autoTradeVerdict as verdictOf } from "@/lib/trading/broker-access/account-trading-policy";')).toBe(true);
    expect(reaches("import { autoTradeVerdictsForAccountIds } from \"@/lib/db/account-brokers\";")).toBe(false);
    expect(scanned.some((f) => f.includes(`${path.sep}app${path.sep}`))).toBe(true);
    expect(scanned.length).toBeGreaterThan(50);
    expect(callers).toEqual([]);
  });

  it("carries an open trade's status into the ladder", () => {
    const trades: BoardTrade[] = [{ deploymentId: "dep-1", status: "pending_exit" }];
    const board = build({
      deployments: [deployment()],
      trades,
      sessionPnl: selector(() => pnl({ hasOpenPosition: true })),
    });

    expect(board[0].legs[0].chip.kind).toBe("pending-exit");
  });

  /**
   * The ladder has rungs for `pending_entry` and `pending_exit` and none for
   * an ordinary `open`, which lands on `hasLivePosition` — a boolean. So a
   * leg the P&L selector cannot answer for must not fall through to a
   * positive claim of flat: with practice-only off, a PRAC leg holding
   * contracts is outside `visibleAccounts` and reads null. The durable trade
   * row is visible-account-independent and answers where the selector cannot.
   */
  it("does not read a leg with no P&L reading as flat while its trade row is open", () => {
    const trades: BoardTrade[] = [{ deploymentId: "dep-1", status: "open" }];
    const board = build({ deployments: [deployment()], trades, sessionPnl: selector(() => null) });

    expect(board[0].legs[0].chip.kind).toBe("in-position");
  });

  /**
   * The reported shape: a Tradovate leg read `FLAT` while holding an open
   * trade row. A reading that says no position is not a confirmation of flat
   * when the durable row says one is open — the reading can lag the fill or
   * fail to map a broker's position onto this leg.
   */
  it("a leg holding an open position can render FLAT — never while its trade row is open", () => {
    const trades: BoardTrade[] = [{ deploymentId: "dep-1", status: "open" }];
    const board = build({
      deployments: [deployment()],
      trades,
      sessionPnl: selector(() => pnl({ hasOpenPosition: false })),
    });

    expect(board[0].legs[0].chip.kind).toBe("in-position");
  });

  it("still reads flat when there is no reading and no open trade row", () => {
    const board = build({ deployments: [deployment()], sessionPnl: selector(() => null) });

    expect(board[0].legs[0].chip.kind).toBe("flat");
  });
});

describe("buildBoard — what one entry may lose is the account's, not the row's", () => {
  const budget = (amount: string): BoardLegRisk => ({
    kind: "budget",
    amount,
    note: "Combine",
    tone: "muted",
    detail: "",
  });

  /** The figure a cell prints, or null for every arm that prints none —
   *  including the absent cell, which is what a book card's row carries. */
  const amountOf = (risk: BoardLegRisk | null): string | null =>
    risk != null && risk.kind === "budget" ? risk.amount : null;

  it("asks by account id, never by deployment id", () => {
    const asked: number[] = [];
    build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
      risk: (accountId) => {
        asked.push(accountId);
        return PENDING_RISK;
      },
    });

    expect(asked.sort()).toEqual([ACCOUNT_A.id, ACCOUNT_B.id]);
  });

  it("gives each leg its own account's budget", () => {
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
      risk: (accountId) => budget(accountId === ACCOUNT_A.id ? "$500" : "$225"),
    });

    expect(board[0].legs.map((l) => amountOf(l.risk))).toEqual(["$500", "$225"]);
  });

  it("states nothing on a leg the live-account block refuses, and does not even ask", () => {
    // Both gates, every time: a figure saying what one entry would risk is a
    // claim about an entry the engine will never take on this account. It is
    // silence rather than an em-dash — an em-dash implies a value that failed
    // to resolve — and rather than a second `no auto-trade` stamp, which the
    // row's own chip is already carrying three columns left.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    try {
      const live: BoardAccount = {
        id: 5003,
        name: "FUNDED-100200-11111111",
        broker: "topstep",
        practice: false,
        autoTrade: { permitted: false, reason: LIVE_ACCOUNT_REFUSAL },
      };
      let asked = 0;
      const board = build({
        accounts: [live],
        deployments: [deployment({ accountId: live.id })],
        risk: () => {
          asked += 1;
          return budget("$500");
        },
      });

      expect(board[0].legs[0].autoTradeRefused).toBe(true);
      expect(board[0].legs[0].risk).toEqual({ kind: "silent" });
      expect(asked).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads one budget onto every row that account owns, and folds none of it onto the card", () => {
    // Two deployments, one account: two rows printing one number. A hand-made
    // card's own `risk` is null — a sum here would be wrong in both
    // directions, since these two share a budget and two legs on two accounts
    // do not spend theirs together. (The field exists for a book card, whose
    // header *is* the row that names the account; it is still never a fold.)
    const board = build({
      groups: [
        { ...PARENT, id: "a", name: "A" },
        { ...PARENT, id: "b", name: "B" },
      ],
      deployments: [
        deployment({ id: "leg-a", groupId: "a", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "b", accountId: ACCOUNT_A.id }),
      ],
      risk: () => budget("$500"),
    });

    expect(board.map((c) => amountOf(c.legs[0].risk))).toEqual(["$500", "$500"]);
    expect(board.map((c) => c.risk)).toEqual([null, null]);
  });
});

describe("buildBoard — session P&L", () => {
  it("aggregates a deployment's legs from the per-leg selector", () => {
    const byLeg: Record<string, PnLBreakdown> = {
      "leg-a": pnl({ realized: 120.5, fees: 2.5, closedCount: 3 }),
      "leg-b": pnl({ realized: -40.25, unrealized: 15, fees: 1.25, closedCount: 1, hasOpenPosition: true }),
    };
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
      sessionPnl: selector((id) => byLeg[id] ?? pnl()),
    });

    expect(board[0].sessionPnl).toEqual({
      realized: 80.25,
      unrealized: 15,
      fees: 3.75,
      total: 95.25,
      closedCount: 4,
      hasOpenPosition: true,
    });
    expect(board[0].openPositionCount).toBe(1);
    expect(board[0].legs.map((l) => l.sessionPnl?.realized)).toEqual([120.5, -40.25]);
  });

  it("A68 — carries a leg's missing unrealized reading to the card, keeping realized and the count", () => {
    const byLeg: Record<string, PnLBreakdown> = {
      "leg-a": pnl({ realized: 120.5, unrealized: 15, total: 135.5, hasOpenPosition: true }),
      "leg-b": pnl({ realized: -40.25, unrealized: null, total: null, hasOpenPosition: true }),
    };
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
      sessionPnl: selector((id) => byLeg[id] ?? pnl()),
    });

    expect(board[0].sessionPnl?.unrealized).toBeNull();
    expect(board[0].sessionPnl?.total).toBeNull();
    expect(board[0].sessionPnl?.realized).toBe(80.25);
    expect(board[0].openPositionCount).toBe(2);
    expect(board[0].legs.map((l) => l.sessionPnl?.unrealized)).toEqual([15, null]);
  });

  it("reports zero legs in position on a quiet board", () => {
    const board = build({ deployments: [deployment()] });

    expect(board[0].openPositionCount).toBe(0);
    expect(board[0].sessionPnl?.closedCount).toBe(0);
  });

  it("hands `null` through for a leg the selector has no reading for", () => {
    // The selector answers for visible accounts only, and a detached leg's
    // account is gone from the catalogue by definition. `$0.00` there is a
    // lie the type used to be unable to tell from a reading — the same
    // defect `size: number | null` exists to prevent, on the field that says
    // how much you are up or down.
    const board = build({
      accounts: [],
      deployments: [
        deployment({ orphanedAt: "2026-09-03T13:00:00.000Z", orphanReason: "account_missing" }),
      ],
      sessionPnl: selector(() => null),
    });

    expect(board[0].legs[0].sessionPnl).toBeNull();
    expect(board[0].sessionPnl).toBeNull();
    expect(board[0].openPositionCount).toBeNull();
  });

  it("refuses to fold a card where one leg of two has no reading", () => {
    // Summing the legs it can read would report a total that is a subset of
    // itself — the same lie as one leg's `$0.00`, and harder to spot.
    const board = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
      sessionPnl: selector((id) =>
        id === "leg-a" ? pnl({ realized: 120.5, hasOpenPosition: true }) : null,
      ),
    });

    expect(board[0].legs.map((l) => l.sessionPnl != null)).toEqual([true, false]);
    expect(board[0].sessionPnl).toBeNull();
    expect(board[0].openPositionCount).toBeNull();
  });
});

describe("buildBoard — what the card's controls act on", () => {
  it("points a one-leg deployment's controls at its parent, not at the leg", () => {
    // The `deployment` target went with the standalone shape: ⏸ and ✕ act on
    // the parent whatever the leg count, because a one-leg deployment is a
    // parent with one leg rather than a different kind of row.
    const card = build({ deployments: [deployment()] })[0];

    expect(card.target).toEqual({ kind: "group", id: "parent-1" });
    // The editor has its own route, so the ✎ no longer detours through the
    // strategies page's `editGroup` deep link.
    expect(card.editHref).toBe("/deployments/parent-1/edit");
  });

  it("points a grouped deployment's controls at the group routes", () => {
    const card = build({
      groups: [group()],
      deployments: [deployment({ groupId: "grp-1" })],
    })[0];

    expect(card.target).toEqual({ kind: "group", id: "grp-1" });
    expect(card.editHref).toBe("/deployments/grp-1/edit");
  });

  it("still says group for a group holding exactly one leg", () => {
    // `legs.length > 1` is the discriminator a component would reach for and
    // it is wrong here: ⏸ on this card is still the group's enable/disable
    // cascade, and ✕ is still the group's flat-gated destroy.
    const card = build({
      groups: [group()],
      deployments: [deployment({ id: "only-leg", groupId: "grp-1" })],
    })[0];

    expect(card.legs).toHaveLength(1);
    expect(card.target).toEqual({ kind: "group", id: "grp-1" });
  });

  it("points a leg whose group row is gone at the deployment routes", () => {
    // The card is the leg. There is no group left to PATCH or DELETE, so
    // addressing one would 404 on the operator's pause.
    const card = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    })[0];

    expect(card.target).toEqual({ kind: "deployment", id: "orphan-leg" });
  });

  it("has no edit link at all for that card", () => {
    // `?edit=<legId>` resolves *up* to the parent, and this target exists
    // exactly when the parent is gone — so the link was a guaranteed silent
    // no-op: no navigation, no message. Null is the honest answer, and the
    // two surfaces that render ✎ turn it into a reason.
    const card = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    })[0];

    expect(card.editHref).toBeNull();
  });
});

describe("buildBoard — a derived row says which book made it", () => {
  it("carries the parent's book id onto the card", () => {
    // The card's only signal that the reconciler owns this row's lifecycle.
    // Without it the ✕ and the card ⏸ are live buttons that 409, which is the
    // refusal met after pressing rather than before.
    const board = build({
      groups: [group({ bookId: "book-1" })],
      deployments: [deployment({ id: "leg-a", groupId: "grp-1" })],
    });

    expect(board[0].bookId).toBe("book-1");
  });

  it("is null on a hand-made deployment", () => {
    // Which is every row on an install that has never opened a book — the
    // unbackfilled value is the inert one, all the way to the card.
    const board = build({ deployments: [deployment()] });

    expect(board[0].bookId).toBeNull();
  });

  it("is null on a leg whose parent row is gone", () => {
    // The pointer lives on the parent, and so do the two routes that refuse a
    // derived row — a leg with no parent is addressed by neither.
    const board = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    });

    expect(board[0].bookId).toBeNull();
  });
});

describe("buildBoard — a book is one card and its rows are playbooks", () => {
  const BOOK = "book-1";
  const SESSION = { start: "09:30", end: "15:55", timezone: "America/New_York" } as const;

  /** Two armed playbooks on one book: two parents carrying one `book_id`, one
   *  leg each, one account, one instrument. Deliberately handed to
   *  `buildBoard` in the order the *second* one sorts, so the row order under
   *  test is the comparator's rather than the input's. */
  function bookInput(overrides: Partial<BoardInput> = {}): Partial<BoardInput> {
    return {
      groups: [
        { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK },
        { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK },
      ],
      deployments: [
        deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb" }),
        deployment({ id: "leg-ema", groupId: "grp-ema", strategyKey: "ema-bounce" }),
      ],
      strategy: (key) =>
        key === "orb"
          ? { name: "Opening Range Breakout", timeframe: "5m", session: SESSION }
          : key === "ema-bounce"
            ? { name: "EMA Bounce", timeframe: "1m", session: SESSION }
            : null,
      groupByBook: true,
      ...overrides,
    };
  }

  it("carries its account's balance and stamp on the card, asked by that account", () => {
    const status: BoardAccountStatus = {
      balance: { kind: "amount", amount: "$48,722.90", detail: "Balance as of 17:55 ET" },
      stamp: { text: "dead", detail: "dead reason" },
    };
    const asked: number[] = [];
    const board = build(
      bookInput({
        accountStatus: (accountId) => {
          asked.push(accountId);
          return status;
        },
      }),
    );

    expect(board[0].account).toEqual(status);
    expect(new Set(asked)).toEqual(new Set([ACCOUNT_A.id]));
  });

  it("carries no account status where none was passed — the drill-in's grouping", () => {
    expect(build(bookInput())[0].account).toBeNull();
  });

  it("carries none on a hand-made card, even when it is passed", () => {
    const board = build({
      groups: [group()],
      deployments: [deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id })],
      groupByBook: true,
      accountStatus: () => ({ balance: { kind: "pending" }, stamp: null }),
    });
    expect(board[0].account).toBeNull();
  });

  it("renders two derived rows as one card, one row per playbook", () => {
    const board = build(bookInput());

    expect(board).toHaveLength(1);
    expect(board[0].id).toBe(BOOK);
    expect(board[0].legs.map((l) => l.id)).toEqual(["leg-ema", "leg-orb"]);
    expect(board[0].legs.map((l) => l.playbookKey)).toEqual(["ema-bounce", "orb"]);
    expect(board[0].legs.map((l) => l.playbookName)).toEqual([
      "EMA Bounce",
      "Opening Range Breakout",
    ]);
  });

  it("labels the card with the account alone, and names no playbook", () => {
    // The header is the card's identity: one account, across contracts. The
    // three per-playbook fields are blank because each row has its own, and
    // one of them printed here would be one row's identity over both.
    const board = build(bookInput());

    expect(board[0].name).toBe(ACCOUNT_A.name);
    expect(board[0].hasCustomName).toBe(false);
    expect(board[0].strategyKey).toBe("");
    expect(board[0].timeframe).toBeNull();
    expect(board[0].sessionWindow).toBeNull();
    expect(board[0].intent).toEqual([]);
  });

  it("folds one book's rows on two contracts into one card, each row naming its contract", () => {
    const board = build(
      bookInput({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, ticker: "/MES" },
        ],
        deployments: [
          deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb" }),
          deployment({ id: "leg-ema", groupId: "grp-ema", strategyKey: "ema-bounce", ticker: "/MES" }),
        ],
        regime: () => ({ label: "TREND", detail: "one instrument's reading" }),
      }),
    );

    expect(board).toHaveLength(1);
    expect(board[0].name).toBe(ACCOUNT_A.name);
    // Grouped by contract under the account, the comparator's order.
    expect(board[0].legs.map((l) => [l.contract, l.playbookKey])).toEqual([
      ["MES", "ema-bounce"],
      ["MNQ", "orb"],
    ]);
    // One instrument's regime is no reading for a card spanning two.
    expect(board[0].regime).toBeNull();
  });

  it("keeps the regime chip on a book card whose rows share one contract", () => {
    const board = build(
      bookInput({ regime: () => ({ label: "TREND", detail: "one instrument's reading" }) }),
    );
    expect(board[0].regime).toEqual({ label: "TREND", detail: "one instrument's reading" });
  });

  it("addresses no lifecycle route and offers no card-level edit", () => {
    // The reconciler writes a derived row's `enabled` and its `status`; the
    // `✕` and both `⏸` are inert over it, so there is no surface for this
    // card's target to name. The `✎` has no single subject either — each row
    // is its own deployment with its own page.
    const board = build(bookInput());

    expect(board[0].target).toEqual({ kind: "book", id: BOOK });
    expect(board[0].editHref).toBeNull();
  });

  it("states the budget once, in the header, and on no row", () => {
    // The no-fold rule re-read rather than excepted: the card spans one
    // account, so the header *is* the surface that names it. Nothing is
    // summed, and a row that names a playbook states no budget at all.
    const board = build(
      bookInput({
        risk: () => ({
          kind: "budget",
          amount: "$500",
          note: "Combine",
          tone: "muted",
          detail: "",
        }),
      }),
    );

    expect(board[0].risk).toEqual({
      kind: "budget",
      amount: "$500",
      note: "Combine",
      tone: "muted",
      detail: "",
    });
    expect(board[0].legs.map((l) => l.risk)).toEqual([null, null]);
  });

  it("states nothing at all on a book whose account the live-account block refuses", () => {
    // The same gate the leg cell owes, on the surface the figure moved to —
    // and `armed` is deliberately not the second one: a stood-down book's
    // account still has the budget its next entry would use.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "prod");
    try {
      const live: BoardAccount = {
        id: 5003,
        name: "FUNDED-100200-11111111",
        broker: "topstep",
        practice: false,
        autoTrade: { permitted: false, reason: LIVE_ACCOUNT_REFUSAL },
      };
      let asked = 0;
      const board = build(
        bookInput({
          accounts: [live],
          deployments: [
            deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb", accountId: live.id }),
            deployment({
              id: "leg-ema",
              groupId: "grp-ema",
              strategyKey: "ema-bounce",
              accountId: live.id,
            }),
          ],
          risk: () => {
            asked += 1;
            return { kind: "budget", amount: "$500", note: null, tone: "muted", detail: "" };
          },
        }),
      );

      expect(board[0].risk).toEqual({ kind: "silent" });
      expect(asked).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("states the switch position off its rows, since nothing else can", () => {
    // The glyph is inert either way, and an inert toggle still states the
    // position — so `▶` over a book with a row switched on is the one thing
    // this must not answer.
    const onePaused = build(
      bookInput({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: false },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: true },
        ],
      }),
    );
    const allPaused = build(
      bookInput({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: false },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: false },
        ],
      }),
    );

    expect(onePaused[0].switchOn).toBe(true);
    expect(allPaused[0].switchOn).toBe(false);
  });

  it("leaves a hand-made deployment beside it exactly as it was", () => {
    // The dual grouping is the additive half made visible: a row with no
    // `book_id` groups by its parent, keeps its own name, its strategy key and
    // its per-leg risk cell, and is addressed by `/api/groups/[id]` as before.
    const board = build(
      bookInput({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK },
          { ...PARENT, id: "grp-hand", name: "Hand made", strategyKey: "ema-crossover" },
        ],
        deployments: [
          deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb" }),
          deployment({ id: "leg-ema", groupId: "grp-ema", strategyKey: "ema-bounce" }),
          deployment({ id: "leg-hand", groupId: "grp-hand", accountId: ACCOUNT_B.id }),
        ],
        strategy: (key) =>
          key === "orb"
            ? { name: "Opening Range Breakout", timeframe: "5m", session: SESSION }
            : key === "ema-bounce"
              ? { name: "EMA Bounce", timeframe: "1m", session: SESSION }
              : key === "ema-crossover"
                ? { name: "EMA Crossover", timeframe: "5m", session: SESSION }
                : null,
      }),
    );

    expect(board).toHaveLength(2);
    const hand = board.find((c) => c.id === "grp-hand")!;
    expect(hand.name).toBe("Hand made");
    expect(hand.strategyKey).toBe("ema-crossover");
    expect(hand.bookId).toBeNull();
    expect(hand.target).toEqual({ kind: "group", id: "grp-hand" });
    expect(hand.editHref).toBe("/deployments/grp-hand/edit");
    expect(hand.risk).toBeNull();
    expect(hand.legs[0].risk).toEqual(PENDING_RISK);
    expect(hand.sessionWindow).toEqual(SESSION);
  });

  it("groups by the parent for a caller that did not ask for books", () => {
    // The drill-in and the editor share this adapter and address *one
    // deployment*: a page that answered "what has this playbook done here"
    // over a book card would be answering with two playbooks' trades.
    const board = build(bookInput({ groupByBook: false }));

    expect(board.map((c) => c.id).sort()).toEqual(["grp-ema", "grp-orb"]);
    expect(board.every((c) => c.bookId === BOOK)).toBe(true);
    expect(board.every((c) => c.legs.length === 1)).toBe(true);
    // Each is still one deployment, so each keeps its own editor and its own
    // per-leg risk cell.
    expect(board.map((c) => c.editHref)).toEqual([
      "/deployments/grp-ema/edit",
      "/deployments/grp-orb/edit",
    ]);
    expect(board.every((c) => c.risk == null && c.legs[0].risk != null)).toBe(true);
  });
});

describe("buildBoard — a switched-off book at rest is dormant, and nothing else is", () => {
  const BOOK = "book-1";
  const SESSION = { start: "09:30", end: "15:55", timezone: "America/New_York" } as const;

  /** What a book switched off leaves behind: the reconciler stood its one
   *  derived row down, so the parent is disabled and its leg is `Paused`. The
   *  row cannot be deleted, which is why the card would otherwise sit there. */
  function offBook(overrides: Partial<BoardInput> = {}): Partial<BoardInput> {
    return {
      groups: [{ ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: false }],
      deployments: [
        deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb", status: "Paused" }),
      ],
      books: [{ id: BOOK, enabled: false }],
      strategy: (key) =>
        key === "orb" ? { name: "Opening Range Breakout", timeframe: "5m", session: SESSION } : null,
      groupByBook: true,
      tradesRead: true,
      ...overrides,
    };
  }

  function leg(overrides: Partial<Deployment> = {}): Deployment {
    return deployment({
      id: "leg-orb",
      groupId: "grp-orb",
      strategyKey: "orb",
      status: "Paused",
      ...overrides,
    });
  }

  it("marks the card of a book that is off, with every row paused and nothing open", () => {
    const board = build(offBook());

    // Still built — the board's adapter deletes nothing and neither does this.
    expect(board).toHaveLength(1);
    expect(board[0].dormant).toBe(true);
  });

  it("reads the book's own switch, never the rows: the same rows under a book that is on stay", () => {
    // Armed-but-idle, and a book that is on with every playbook disarmed, both
    // look exactly like this from the rows. The operator has to see them.
    const board = build(offBook({ books: [{ id: BOOK, enabled: true }] }));

    expect(board[0].dormant).toBe(false);
  });

  it("stays visible when the book's switch was never read", () => {
    expect(build(offBook({ books: undefined }))[0].dormant).toBe(false);
    expect(build(offBook({ books: [] }))[0].dormant).toBe(false);
  });

  it("stays visible until the trade rows have been read — an unread or failed read is not *nothing open*", () => {
    // The trade rows are the only position signal; `[]` before they arrive, or
    // after a fetch that failed, would otherwise read as at rest.
    expect(build(offBook({ tradesRead: undefined }))[0].dormant).toBe(false);
    expect(build(offBook({ tradesRead: false }))[0].dormant).toBe(false);
    expect(build(offBook({ tradesRead: true }))[0].dormant).toBe(true);
  });

  it.each(["Pausing", "Destroying", "Active"] as const)(
    "stays visible while a row is %s",
    (status) => {
      // `Pausing` / `Destroying` owe a close at the broker. `Active` under an
      // off book is a row holding its own slot with nothing trading it.
      expect(build(offBook({ deployments: [leg({ status })] }))[0].dormant).toBe(false);
    },
  );

  it.each(["open", "pending_entry", "pending_exit"] as const)(
    "stays visible while a row has a trade that is %s",
    (status) => {
      const trades: BoardTrade[] = [{ deploymentId: "leg-orb", status }];

      expect(build(offBook({ trades }))[0].dormant).toBe(false);
    },
  );

  it("stays visible while the live reading says a row holds a position", () => {
    const board = build(offBook({ sessionPnl: selector(() => pnl({ hasOpenPosition: true })) }));

    expect(board[0].dormant).toBe(false);
  });

  it("stays visible while a row is detached", () => {
    const board = build(
      offBook({ deployments: [leg({ orphanReason: "account_unavailable_at_boot" })] }),
    );

    expect(board[0].dormant).toBe(false);
  });

  it("stays visible while a row is flagged for the operator to reconcile", () => {
    const board = build(
      offBook({ deployments: [leg({ pendingReconciliation: "session window changed" })] }),
    );

    expect(board[0].dormant).toBe(false);
  });

  it("stays visible while one of its parents is still switched on", () => {
    // The book says off and a row says on: a stand-down that has not landed.
    const board = build(
      offBook({
        groups: [{ ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: true }],
      }),
    );

    expect(board[0].dormant).toBe(false);
  });

  it("takes one restless row to keep a two-row card", () => {
    const board = build(
      offBook({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: false },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: false },
        ],
        deployments: [
          leg(),
          leg({ id: "leg-ema", groupId: "grp-ema", strategyKey: "ema-bounce", status: "Pausing" }),
        ],
      }),
    );

    expect(board).toHaveLength(1);
    expect(board[0].dormant).toBe(false);
  });

  it("decides off the durable rows when there is no live reading at all", () => {
    // A practice-filtered account and a dropped connection both answer `null`.
    // `Paused` with no open trade row is the database saying no close is owed,
    // so the card does not flicker back in whenever the reading goes blind.
    const board = build(offBook({ sessionPnl: selector(() => null) }));

    expect(board[0].dormant).toBe(true);
  });

  it("never marks a hand-made card, however quiet", () => {
    const board = build({
      groups: [{ ...PARENT, enabled: false }],
      deployments: [deployment({ status: "Paused" })],
      books: [{ id: BOOK, enabled: false }],
      groupByBook: true,
    });

    expect(board[0].dormant).toBe(false);
  });

  it("never marks anything for a caller that did not ask for books", () => {
    // The drill-in and the editor: a derived row's own page must still open.
    expect(build(offBook({ groupByBook: false }))[0].dormant).toBe(false);
  });

  it("is never true of a card holding a position, so the strip's Open count loses nothing", () => {
    const readings = [pnl(), pnl({ hasOpenPosition: true }), null];
    const statuses = ["Paused", "Pausing", "Active", "Destroying"] as const;
    const tradeSets: BoardTrade[][] = [[], [{ deploymentId: "leg-orb", status: "open" }]];

    for (const reading of readings) {
      for (const status of statuses) {
        for (const trades of tradeSets) {
          const [card] = build(
            offBook({
              deployments: [leg({ status })],
              trades,
              sessionPnl: selector(() => reading),
            }),
          );
          if (!card.dormant) continue;
          expect(card.openPositionCount ?? 0).toBe(0);
          expect(card.legs.every((l) => l.sessionPnl?.hasOpenPosition !== true)).toBe(true);
          expect(trades).toEqual([]);
          expect(status).toBe("Paused");
        }
      }
    }
  });
});

describe("buildBoard — a book card's row of a playbook off and at rest is dormant, and nothing else is", () => {
  const BOOK = "book-1";
  const SESSION = { start: "09:30", end: "15:55", timezone: "America/New_York" } as const;

  /** The prod shape: a book that is on, one armed playbook running and one
   *  disarmed one the reconciler stood down — parent disabled, leg `Paused`. */
  function onBook(overrides: Partial<BoardInput> = {}): Partial<BoardInput> {
    return {
      groups: [
        { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: true },
        { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: false },
      ],
      deployments: [
        deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb", status: "Active" }),
        deployment({ id: "leg-ema", groupId: "grp-ema", strategyKey: "ema-bounce", status: "Paused" }),
      ],
      books: [
        {
          id: BOOK,
          enabled: true,
          playbooks: [
            { ticker: "/MNQ", strategyKey: "orb", armed: true },
            { ticker: "/MNQ", strategyKey: "ema-bounce", armed: false },
          ],
        },
      ],
      strategy: (key) =>
        key === "orb" || key === "ema-bounce"
          ? { name: key, timeframe: "5m", session: SESSION }
          : null,
      groupByBook: true,
      tradesRead: true,
      ...overrides,
    };
  }

  function emaLeg(overrides: Partial<Deployment> = {}): Deployment {
    return deployment({
      id: "leg-ema",
      groupId: "grp-ema",
      strategyKey: "ema-bounce",
      status: "Paused",
      ...overrides,
    });
  }

  const ORB_LEG = deployment({ id: "leg-orb", groupId: "grp-orb", strategyKey: "orb", status: "Active" });

  function dormantById(board: ReturnType<typeof build>): Record<string, boolean> {
    return Object.fromEntries(board.flatMap((c) => c.legs).map((l) => [l.id, l.dormant]));
  }

  it("marks a disarmed row at rest, and leaves the armed row and the card alone", () => {
    const board = build(onBook());

    expect(board).toHaveLength(1);
    expect(board[0].dormant).toBe(false);
    // Still built — nothing is deleted here.
    expect(board[0].legs).toHaveLength(2);
    expect(dormantById(board)).toEqual({ "leg-orb": false, "leg-ema": true });
  });

  it("marks an unregistered row at rest whatever its cell says", () => {
    // Prod: `ema-bounce` is not in the build. Its cell may even read armed.
    const board = build(
      onBook({
        strategy: (key) =>
          key === "orb" ? { name: "orb", timeframe: "5m", session: SESSION } : null,
        books: [{ id: BOOK, enabled: true, playbooks: [{ ticker: "/MNQ", strategyKey: "ema-bounce", armed: true }] }],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(true);
  });

  it("keeps an armed row that is idle: a stood-down parent under an armed cell is A83", () => {
    const board = build(
      onBook({
        books: [
          {
            id: BOOK,
            enabled: true,
            playbooks: [{ ticker: "/MNQ", strategyKey: "ema-bounce", armed: true }],
          },
        ],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("keeps an armed row always, at rest or not", () => {
    const board = build(onBook());

    expect(dormantById(board)["leg-orb"]).toBe(false);
  });

  it("keeps the row when its cell was never read", () => {
    expect(dormantById(build(onBook({ books: [{ id: BOOK, enabled: true }] })))["leg-ema"]).toBe(false);
    expect(dormantById(build(onBook({ books: undefined })))["leg-ema"]).toBe(false);
  });

  it("keeps the row until the trade rows have been read — an unread or failed read is not *nothing open*", () => {
    expect(dormantById(build(onBook({ tradesRead: undefined })))["leg-ema"]).toBe(false);
    expect(dormantById(build(onBook({ tradesRead: false })))["leg-ema"]).toBe(false);
    expect(dormantById(build(onBook({ tradesRead: true })))["leg-ema"]).toBe(true);
  });

  it("keeps an unregistered row until the trade rows have been read", () => {
    const board = build(
      onBook({
        strategy: (key) =>
          key === "orb" ? { name: "orb", timeframe: "5m", session: SESSION } : null,
        tradesRead: false,
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("matches the cell on its book too: a disarmed cell on book-2 does not hide book-1's row", () => {
    const board = build(
      onBook({
        books: [
          { id: BOOK, enabled: true, playbooks: [{ ticker: "/MNQ", strategyKey: "ema-bounce", armed: true }] },
          { id: "book-2", enabled: true, playbooks: [{ ticker: "/MNQ", strategyKey: "ema-bounce", armed: false }] },
        ],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("matches the cell on its ticker too: a disarmed MES cell does not hide the MNQ row", () => {
    const board = build(
      onBook({
        books: [
          {
            id: BOOK,
            enabled: true,
            playbooks: [
              { ticker: "/MES", strategyKey: "ema-bounce", armed: false },
              { ticker: "/MNQ", strategyKey: "ema-bounce", armed: true },
            ],
          },
        ],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it.each(["Pausing", "Destroying", "Active"] as const)("keeps a disarmed row that is %s", (status) => {
    const board = build(onBook({ deployments: [ORB_LEG, emaLeg({ status })] }));

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it.each(["open", "pending_entry", "pending_exit"] as const)(
    "keeps a disarmed row with a trade that is %s",
    (status) => {
      const board = build(onBook({ trades: [{ deploymentId: "leg-ema", status }] }));

      expect(dormantById(board)["leg-ema"]).toBe(false);
    },
  );

  it("keeps a disarmed row the live reading says is in position", () => {
    const board = build(
      onBook({ sessionPnl: selector((id) => pnl({ hasOpenPosition: id === "leg-ema" })) }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("keeps a disarmed row that is detached", () => {
    const board = build(
      onBook({
        deployments: [ORB_LEG, emaLeg({ orphanReason: "account_unavailable_at_boot" })],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("keeps a disarmed row flagged for the operator to reconcile", () => {
    const board = build(
      onBook({
        deployments: [ORB_LEG, emaLeg({ pendingReconciliation: "session window changed" })],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("keeps a disarmed row whose parent is still switched on — a stand-down that has not landed", () => {
    const board = build(
      onBook({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: true },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: true },
        ],
      }),
    );

    expect(dormantById(board)["leg-ema"]).toBe(false);
  });

  it("never marks a hand-made row, or anything for a caller that did not ask for books", () => {
    const handMade = build({
      groups: [{ ...PARENT, enabled: false }],
      deployments: [deployment({ status: "Paused" })],
      strategy: () => null,
      groupByBook: true,
    });
    expect(handMade[0].legs[0].dormant).toBe(false);

    expect(Object.values(dormantById(build(onBook({ groupByBook: false }))))).toEqual([false, false]);
  });

  it("leaves a whole switched-off book's card as before: dormant, every row built", () => {
    const board = build(
      onBook({
        groups: [
          { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: false },
          { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: false },
        ],
        deployments: [{ ...ORB_LEG, status: "Paused" }, emaLeg()],
        books: [
          {
            id: BOOK,
            enabled: false,
            playbooks: [
              { ticker: "/MNQ", strategyKey: "orb", armed: true },
              { ticker: "/MNQ", strategyKey: "ema-bounce", armed: false },
            ],
          },
        ],
      }),
    );

    expect(board[0].dormant).toBe(true);
    expect(board[0].legs).toHaveLength(2);
  });

  describe("an unregistered playbook under an armed cell keeps its row for every reason a registered one does", () => {
    // The playbook is off by being absent from the build, and its cell reads
    // armed, so `playbookOff` is true on the build alone. Every case below
    // must still keep the row on the rest half: a predicate that let
    // `strategy == null` stand on its own would fail each of them.
    function unregistered(overrides: Partial<BoardInput> = {}): Partial<BoardInput> {
      return onBook({
        strategy: (key) =>
          key === "orb" ? { name: "orb", timeframe: "5m", session: SESSION } : null,
        books: [
          {
            id: BOOK,
            enabled: true,
            playbooks: [
              { ticker: "/MNQ", strategyKey: "orb", armed: true },
              { ticker: "/MNQ", strategyKey: "ema-bounce", armed: true },
            ],
          },
        ],
        ...overrides,
      });
    }

    it("is hidden at rest — the control the cases below depart from", () => {
      expect(dormantById(build(unregistered()))["leg-ema"]).toBe(true);
    });

    it.each(["open", "pending_entry", "pending_exit"] as const)(
      "keeps the row with a trade that is %s",
      (status) => {
        const board = build(unregistered({ trades: [{ deploymentId: "leg-ema", status }] }));

        expect(dormantById(board)["leg-ema"]).toBe(false);
      },
    );

    it.each(["Pausing", "Destroying", "Active"] as const)("keeps the row that is %s", (status) => {
      const board = build(unregistered({ deployments: [ORB_LEG, emaLeg({ status })] }));

      expect(dormantById(board)["leg-ema"]).toBe(false);
    });

    it("keeps the row the live reading says is in position", () => {
      const board = build(
        unregistered({ sessionPnl: selector((id) => pnl({ hasOpenPosition: id === "leg-ema" })) }),
      );

      expect(dormantById(board)["leg-ema"]).toBe(false);
    });

    it("keeps the row that is detached", () => {
      const board = build(
        unregistered({
          deployments: [ORB_LEG, emaLeg({ orphanReason: "account_unavailable_at_boot" })],
        }),
      );

      expect(dormantById(board)["leg-ema"]).toBe(false);
    });

    it("keeps the row flagged for the operator to reconcile", () => {
      const board = build(
        unregistered({
          deployments: [ORB_LEG, emaLeg({ pendingReconciliation: "session window changed" })],
        }),
      );

      expect(dormantById(board)["leg-ema"]).toBe(false);
    });

    it("keeps the row whose parent is still switched on", () => {
      const board = build(
        unregistered({
          groups: [
            { ...PARENT, id: "grp-orb", strategyKey: "orb", bookId: BOOK, enabled: true },
            { ...PARENT, id: "grp-ema", strategyKey: "ema-bounce", bookId: BOOK, enabled: true },
          ],
        }),
      );

      expect(dormantById(board)["leg-ema"]).toBe(false);
    });
  });
});

describe("buildBoard — switchOn is the ⏸/▶ direction, and it is not the armed fold", () => {
  it("reads a one-leg deployment's switch off its parent, not the leg status", () => {
    // The switch is the parent's `enabled` for every card now. A leg paused
    // individually leaves the parent on, and ▶ built off the leg's status
    // would submit a body `PATCH /api/groups/[id]` treats as no transition.
    const board = build({
      groups: [
        { ...PARENT, id: "on", enabled: true },
        { ...PARENT, id: "off", enabled: false },
      ],
      deployments: [
        deployment({ id: "leg-on", groupId: "on" }),
        deployment({ id: "leg-off", groupId: "off", status: "Paused" }),
      ],
    });

    expect(board.map((c) => [c.id, c.switchOn])).toEqual([
      ["off", false],
      ["on", true],
    ]);
  });

  it("reads a group's switch off `group.enabled`, not its legs", () => {
    // The state the fold cannot see: the group is enabled and every leg was
    // paused individually through `PATCH /api/deployments/[id]`, which never
    // touches `group.enabled`. `armed` folds to false; ▶ on that would send
    // `{enabled: true}` over `enabled = 1`, which `isEnableTransition`
    // rejects — `enableGroupAndRestore` never runs and the resume does
    // nothing at all.
    const card = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id, status: "Paused" }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id, status: "Paused" }),
      ],
    })[0];

    expect(card.armed).toBe(false);
    expect(card.switchOn).toBe(true);
  });

  it("turns a disabled group's switch off while its legs still read Active", () => {
    const card = build({
      groups: [group({ enabled: false })],
      deployments: [deployment({ id: "leg-a", groupId: "grp-1" })],
    })[0];

    expect(card.legs.map((l) => l.status)).toEqual(["Active"]);
    expect(card.switchOn).toBe(false);
  });

  it("reads a gone-group leg's switch off the row the card actually addresses", () => {
    // `target` is `deployment` here, so the toggle is `toggleDeployment` and
    // the switch has to be that row's own status — the leg is `armed: false`
    // only because the engine refuses a leg whose group it cannot find.
    const card = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    })[0];

    expect(card.target.kind).toBe("deployment");
    expect(card.armed).toBe(false);
    expect(card.switchOn).toBe(true);
  });
});

describe("buildBoard — armed is the engine's entry gate, and it is not `status`", () => {
  it("arms an Active standalone", () => {
    const card = build({ deployments: [deployment()] })[0];

    expect(card.legs[0].armed).toBe(true);
    expect(card.armed).toBe(true);
  });

  it("disarms a Paused standalone", () => {
    expect(build({ deployments: [deployment({ status: "Paused" })] })[0].armed).toBe(false);
  });

  it("disarms every leg of a disabled group, whatever the leg status says", () => {
    // The state `enabledSnapshot` exists to preserve: the group is off and
    // its legs still read `Active`. A chip rendered from `status` alone
    // would claim the leg is about to trade; the leg's own ⏸ still reads
    // `status`, because a leg inside a disabled group keeps its own switch.
    const card = build({
      groups: [group({ enabled: false })],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id }),
      ],
    })[0];

    expect(card.legs.map((l) => [l.status, l.armed])).toEqual([
      ["Active", false],
      ["Active", false],
    ]);
    expect(card.armed).toBe(false);
  });

  it("arms a group on any one armed leg — the fold is an OR, never the switch", () => {
    const card = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-a", groupId: "grp-1", accountId: ACCOUNT_A.id }),
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id, status: "Paused" }),
      ],
    })[0];

    expect(card.legs.map((l) => l.armed)).toEqual([true, false]);
    expect(card.armed).toBe(true);
  });

  it("disarms a leg whose group row is gone", () => {
    // Mirrors the engine: `isLegEngineEnabled` returns false when a leg names
    // a group its cache has no row for.
    const card = build({
      groups: [],
      deployments: [deployment({ id: "orphan-leg", groupId: "grp-gone" })],
    })[0];

    expect(card.armed).toBe(false);
  });

  it("disarms a leg mid-close, which the chip does not say either way", () => {
    const board = build({
      groups: [
        { ...PARENT, id: "p1" },
        { ...PARENT, id: "p2" },
      ],
      deployments: [
        deployment({ id: "pausing", groupId: "p1", status: "Pausing" }),
        deployment({ id: "destroying", groupId: "p2", status: "Destroying" }),
      ],
    });

    expect(board.map((c) => c.armed)).toEqual([false, false]);
  });
});

describe("buildBoard — timeframe", () => {
  it("takes the strategy's default", () => {
    expect(build({ deployments: [deployment()] })[0].timeframe).toBe("5m");
  });

  it("takes a param override over the strategy default", () => {
    const board = build({
      groups: [{ ...PARENT, paramValues: { size: 1, timeframe: "15m" } }],
      deployments: [deployment()],
    });
    expect(board[0].timeframe).toBe("15m");
  });

  it("is null when the strategy is unknown and the params name none", () => {
    const board = build({
      groups: [{ ...PARENT, strategyKey: "deleted-strategy" }],
      deployments: [deployment()],
    });
    expect(board[0].timeframe).toBeNull();
  });
});

describe("buildBoard — intent is guidance carried through, never derived", () => {
  it("carries the strategy's config.intent verbatim onto the card", () => {
    const board = build({
      strategy: () => ({
        name: "EMA Crossover",
        timeframe: "5m",
        session: { start: "09:30", end: "15:55", timezone: "America/New_York" },
        intent: ["growth"],
      }),
      deployments: [deployment()],
    });
    expect(board[0].intent).toEqual(["growth"]);
  });

  it("is empty, not missing, when the strategy declares none or is unknown", () => {
    expect(build({ deployments: [deployment()] })[0].intent).toEqual([]);
    const unknown = build({
      groups: [{ ...PARENT, strategyKey: "deleted-strategy" }],
      deployments: [deployment()],
    });
    expect(unknown[0].intent).toEqual([]);
  });
});

describe("buildBoard — the session window on the meta line", () => {
  it("carries the playbook's own bounds and zone verbatim", () => {
    const card = build({ deployments: [deployment()] })[0];

    expect(card.sessionWindow).toEqual({
      start: "09:30",
      end: "15:55",
      timezone: "America/New_York",
    });
  });

  it("ignores a stale window in the blob — the playbook's is the only one", () => {
    // A row written before the session moved onto the module still carries a
    // `mainSession` key. Reading it would put a window on the card the engine
    // does not trade, which is the failure the move closed.
    const card = build({
      deployments: [
        deployment({
          paramValues: {
            size: 1,
            mainSession: { start: "18:00", end: "09:00", timezone: "UTC" },
          } as unknown as ParamValues,
        }),
      ],
    })[0];

    expect(card.sessionWindow?.start).toBe("09:30");
    expect(card.sessionWindow?.timezone).toBe("America/New_York");
  });

  it("names no window when the strategy module is unknown", () => {
    const card = build({
      deployments: [deployment()],
      strategy: () => null,
    })[0];

    expect(card.sessionWindow).toBeNull();
  });
});

/**
 * A prod build registers only the allowlist in `strategies/prod-playbooks.ts`,
 * so the board meets rows whose module is not there — `ema-bounce` armed on a
 * combine book among them. The engine refuses them at activation; the row
 * must say so rather than read `Flat` under a live rail.
 */
describe("buildBoard — a row whose playbook this build does not register", () => {
  it("carries the not-in-build rung with the shared sentence, and is not armed", () => {
    const card = build({ deployments: [deployment()], strategy: () => null })[0];
    const leg = card.legs[0];

    expect(leg.chip).toEqual({
      kind: "not-in-build",
      tone: "danger",
      reason: PLAYBOOK_NOT_IN_BUILD,
    });
    expect(leg.armed).toBe(false);
    expect(card.armed).toBe(false);
    expect(leg.playbookName).toBe(PARENT.strategyKey);
  });

  it("leaves a registered row's rung and arming alone", () => {
    const leg = build({ deployments: [deployment()] })[0].legs[0];

    expect(leg.chip.kind).toBe("flat");
    expect(leg.armed).toBe(true);
  });

  it("still says Paused for a paused row, which is the operator's own action", () => {
    const leg = build({
      deployments: [deployment({ status: "Paused" })],
      strategy: () => null,
    })[0].legs[0];

    expect(leg.chip.kind).toBe("paused");
  });
});

describe("buildBoard — the engine's setup reading turns a flat leg's chip to armed", () => {
  const NOTE = "First trading day of the month · enters on the 09:30 bar.";

  it("reads the leg's note into an armed-setup chip, by deployment id", () => {
    const board = build({
      deployments: [deployment()],
      setup: (id) => (id === "dep-1" ? NOTE : null),
    });

    expect(board[0].legs[0].chip).toEqual({ kind: "armed-setup", tone: "warn", reason: NOTE });
  });

  it("is flat when the reading is unread or names another leg", () => {
    expect(build({ deployments: [deployment()] })[0].legs[0].chip.kind).toBe("flat");
    expect(build({ deployments: [deployment()], setup: () => null })[0].legs[0].chip.kind).toBe("flat");
  });

  it("leaves a leg holding a position on its own rung, and does not touch the entry gate", () => {
    const leg = build({
      deployments: [deployment()],
      sessionPnl: selector(() => pnl({ hasOpenPosition: true })),
      setup: () => NOTE,
    })[0].legs[0];

    expect(leg.chip.kind).toBe("in-position");
    expect(leg.armed).toBe(true);
  });

  it("leaves a paused row Paused", () => {
    const leg = build({ deployments: [deployment({ status: "Paused" })], setup: () => NOTE })[0].legs[0];

    expect(leg.chip.kind).toBe("paused");
  });

  describe("another row on the account holding the contract", () => {
    const legs = (holderOverrides: Partial<Deployment>, trades: BoardTrade[]) =>
      build({
        deployments: [
          deployment({ id: "armed", groupId: "parent-1" }),
          deployment({ id: "holder", groupId: "parent-2", strategyKey: "orb", ...holderOverrides }),
        ],
        trades,
        setup: (id) => (id === "armed" ? NOTE : null),
      }).flatMap((c) => c.legs);
    const chipOf = (all: BoardLeg[], id: string) => all.find((l) => l.id === id)!.chip;

    it.each(["open", "pending_entry", "pending_exit"] as const)(
      "reads Blocked, naming the holder, while it has a %s trade",
      (status) => {
        const chip = chipOf(legs({}, [{ deploymentId: "holder", status }]), "armed");
        expect(chip.kind).toBe("setup-blocked");
        expect(chip.tone).toBe("muted");
        expect(chip.reason).toContain(NOTE);
        expect(chip.reason).toContain("Blocked: MNQ on this account is held by");
      },
    );

    it("stays Armed when the holder is on another contract or another account, or holds nothing", () => {
      const trades: BoardTrade[] = [{ deploymentId: "holder", status: "open" }];
      expect(chipOf(legs({ ticker: "/MES" }, trades), "armed").kind).toBe("armed-setup");
      expect(chipOf(legs({ accountId: ACCOUNT_B.id }, trades), "armed").kind).toBe("armed-setup");
      expect(chipOf(legs({}, []), "armed").kind).toBe("armed-setup");
    });
  });
});

describe("buildBoard — the chip row states only gates the row actually carries", () => {
  it("prints nothing for a deployment with no gates set", () => {
    // The SL chip and the Size chip both went with the params behind them.
    // An empty row is the honest answer, not a gap.
    expect(build({ deployments: [deployment()] })[0].legs[0].chips).toBe("");
  });

  it("ignores a stale blob still carrying the retired bracket keys", () => {
    const card = build({
      deployments: [
        deployment({ paramValues: { size: 1, stopLossOverrideTicks: 20, riskRewardRatio: 3 } }),
      ],
    })[0];

    expect(card.legs[0].chips).toBe("");
  });

  it("is per leg, so two legs of one group can differ", () => {
    const card = build({
      groups: [group()],
      deployments: [
        deployment({
          id: "leg-a",
          groupId: "grp-1",
          accountId: ACCOUNT_A.id,
          paramValues: { cooldownSeconds: 30 },
        }),
        deployment({
          id: "leg-b",
          groupId: "grp-1",
          accountId: ACCOUNT_B.id,
          paramValues: { cooldownSeconds: 60 },
        }),
      ],
    })[0];

    expect(card.legs.map((l) => l.chips)).toEqual(["CD: 30s", "CD: 60s"]);
  });
});

describe("buildBoard — the claim a leg carries", () => {
  it("is exactly the preflight body, from the leg's own row", () => {
    // Not the card's: the account is the leg's, and the four wired activation
    // affordances all pass the leg's own `paramValues`.
    const params = { size: 1, riskRewardRatio: 2 };
    const card = build({
      groups: [group()],
      deployments: [
        deployment({ id: "leg-b", groupId: "grp-1", accountId: ACCOUNT_B.id, paramValues: params }),
      ],
    })[0];

    expect(card.legs[0].claim).toEqual({
      accountId: ACCOUNT_B.id,
      ticker: "/MNQ",
      strategyKey: "ema-crossover",
      paramValues: params,
    });
  });
});

/**
 * **The brand's census, made checkable.**
 *
 * `boardSessionPnl`'s own return is the one assertion to `BoardSessionPnl` in
 * `src/`, and that sentence is what the guarantee rests on: the brand stops a
 * component wiring `useLivePnL(...).deployment` straight into
 * `BoardInput.sessionPnl` and reporting every detached and practice-filtered
 * account as flat. But `BoardSessionPnl` is exported and is a *subtype* of the
 * plain selector, so `livePnl.deployment as BoardSessionPnl` compiles
 * anywhere — the sentence was prose, and prose does not fail a build.
 *
 * Both spellings are counted, because the type is reachable by two names and
 * a pin that knows only one is a pin with a door beside it. Test files are
 * excluded deliberately: the fixture in this file asserts the brand on
 * purpose and visibly, which is the thing the brand takes away from
 * production code rather than from the tests about it.
 */
describe("BoardSessionPnl — one assertion in src/, and it is the wrapper's", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
    return out;
  }

  it("is asserted in exactly one place, and it is `boardSessionPnl`'s return", () => {
    const BRAND_ASSERTION =
      /as\s+BoardSessionPnl\b|as\s+BoardInput\[["']sessionPnl["']\]|<BoardSessionPnl>/g;
    const found: Record<string, number> = {};
    for (const file of sourceFiles(path.join(REPO_ROOT, "src"))) {
      const count = (readFileSync(file, "utf8").match(BRAND_ASSERTION) ?? []).length;
      if (count > 0) found[path.relative(REPO_ROOT, file).replace(/\\/g, "/")] = count;
    }
    expect(found).toEqual({ "src/components/board/board-view.ts": 1 });
  });
});
