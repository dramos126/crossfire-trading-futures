import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrokerKind } from "@/lib/db/account-brokers";

// vi.mock() factories are hoisted above every const below, so each one
// must be self-contained. `@/lib/trading/engine-singleton` is mocked
// wholesale to cut the registry-singleton import chain (see
// docs/modules/testing/patterns.md).

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

vi.mock("@/lib/brokers/topstep/client", () => ({
  TopstepClient: vi.fn(),
}));

vi.mock("@/lib/brokers/topstep/browser-token", () => ({
  topstepBrowserToken: vi.fn().mockResolvedValue("topstep-jwt"),
}));

vi.mock("@/lib/db/account-brokers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/account-brokers")>();
  return {
    ...actual,
    getAccountBrokerOrNull: vi.fn().mockReturnValue("topstep"),
  };
});

vi.mock("@/lib/brokers/tradovate/client", () => ({
  readTradovateCredentialsFromDb: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/trading/engine/engine-singleton", () => ({
  getTradovateClientIfConfigured: vi.fn().mockResolvedValue(null),
}));

import {
  createOpenPositionLookup,
  createBootOpenPositionLookup,
  hasOpenPositionOnBroker,
} from "./open-position-lookup";
import { legHasOpenPositionWithFallback } from "../orders/leg-position";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { readTradovateCredentialsFromDb } from "@/lib/brokers/tradovate/client";
import { getAccountBrokerOrNull } from "@/lib/db/account-brokers";
import { getTradovateClientIfConfigured } from "@/lib/trading/engine/engine-singleton";

const TOPSTEP_ACCOUNT = 1001;
const TRADOVATE_ACCOUNT = 2001;
/** No `account_brokers` row — the registry refresh has never tagged it. */
const UNTAGGED_ACCOUNT = 3001;

function stubTopstep(searchOpenPositions: ReturnType<typeof vi.fn>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(TopstepClient).mockImplementation(function (this: any) {
    this.setToken = vi.fn();
    this.searchOpenPositions = searchOpenPositions;
  });
}

function tradovateStub(searchOpenPositions: ReturnType<typeof vi.fn>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getTradovateClientIfConfigured).mockResolvedValue({ searchOpenPositions } as any);
}

/** Routes by account id the way the persisted `account_brokers` table
 *  does — `UNTAGGED_ACCOUNT` has no row, so the lookup gets `null`. */
function routeByAccount() {
  vi.mocked(getAccountBrokerOrNull).mockImplementation((id: number) => {
    if (id === TRADOVATE_ACCOUNT) return BrokerKind.Tradovate;
    if (id === UNTAGGED_ACCOUNT) return null;
    return BrokerKind.Topstep;
  });
}

/** Tradovate credentials present — the install is mixed, so an untagged
 *  account could belong to either broker. */
function tradovateConfigured() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(readTradovateCredentialsFromDb).mockReturnValue({ username: "u" } as any);
}

describe("createOpenPositionLookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTopstep(vi.fn().mockResolvedValue([]));
    vi.mocked(getAccountBrokerOrNull).mockReturnValue(BrokerKind.Topstep);
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);
    vi.mocked(topstepBrowserToken).mockResolvedValue("topstep-jwt");
  });

  it("reads a Tradovate account's open positions from the Tradovate client", async () => {
    routeByAccount();
    const search = vi.fn().mockResolvedValue([
      { id: 7, accountId: TRADOVATE_ACCOUNT, contractId: "MNQM6", size: 1 },
    ]);
    tradovateStub(search);

    const lookup = createOpenPositionLookup();
    const positions = await lookup(TRADOVATE_ACCOUNT);

    expect(positions).toEqual([{ contractId: "MNQM6" }]);
    expect(search).toHaveBeenCalledWith(TRADOVATE_ACCOUNT);
  });

  it("never constructs a TopstepClient for a Tradovate account", async () => {
    routeByAccount();
    tradovateStub(vi.fn().mockResolvedValue([]));

    const lookup = createOpenPositionLookup();
    await lookup(TRADOVATE_ACCOUNT);

    expect(TopstepClient).not.toHaveBeenCalled();
  });

  it("throws when the Tradovate client is unavailable so the caller fails closed", async () => {
    routeByAccount();
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);

    const lookup = createOpenPositionLookup();
    await expect(lookup(TRADOVATE_ACCOUNT)).rejects.toThrow(/Tradovate client unavailable/);
  });

  it("throws rather than returning empty when the plugin has no Topstep token", async () => {
    vi.mocked(topstepBrowserToken).mockResolvedValue(null);
    const lookup = createOpenPositionLookup();
    await expect(lookup(TOPSTEP_ACCOUNT)).rejects.toThrow(/No Topstep token/);
  });

  it("throws rather than returning empty when minting the Topstep token fails", async () => {
    vi.mocked(topstepBrowserToken).mockRejectedValue(new Error("gateway down"));
    const lookup = createOpenPositionLookup();
    await expect(lookup(TOPSTEP_ACCOUNT)).rejects.toThrow(/gateway down/);
  });

  it("never asks Topstep for a token when every account is Tradovate", async () => {
    routeByAccount();
    tradovateStub(vi.fn().mockResolvedValue([]));

    const lookup = createOpenPositionLookup();
    await lookup(TRADOVATE_ACCOUNT);

    expect(topstepBrowserToken).not.toHaveBeenCalled();
  });

  it("reads a Topstep account through a token-stamped TopstepClient", async () => {
    const search = vi.fn().mockResolvedValue([
      { id: 1, accountId: TOPSTEP_ACCOUNT, contractId: "CON.F.US.MNQ.M26", size: 2 },
    ]);
    stubTopstep(search);

    const lookup = createOpenPositionLookup();
    const positions = await lookup(TOPSTEP_ACCOUNT);

    expect(positions).toEqual([{ contractId: "CON.F.US.MNQ.M26" }]);
    expect(search).toHaveBeenCalledWith(TOPSTEP_ACCOUNT);
    expect(getTradovateClientIfConfigured).not.toHaveBeenCalled();
  });

  it("throws for an untagged account while Tradovate is configured", async () => {
    routeByAccount();
    tradovateConfigured();
    const topstepSearch = vi.fn().mockResolvedValue([]);
    stubTopstep(topstepSearch);

    const lookup = createOpenPositionLookup();

    await expect(lookup(UNTAGGED_ACCOUNT)).rejects.toThrow(/no broker tag/);
    expect(topstepSearch).not.toHaveBeenCalled();
  });

  it("keeps the Topstep default for an untagged account when Tradovate is not configured", async () => {
    routeByAccount();
    const topstepSearch = vi.fn().mockResolvedValue([]);
    stubTopstep(topstepSearch);

    const lookup = createOpenPositionLookup();

    await expect(lookup(UNTAGGED_ACCOUNT)).resolves.toEqual([]);
    expect(topstepSearch).toHaveBeenCalledWith(UNTAGGED_ACCOUNT);
  });

  it("routes each account to its own broker within one lookup", async () => {
    routeByAccount();
    const topstepSearch = vi.fn().mockResolvedValue([]);
    stubTopstep(topstepSearch);
    const tradovateSearch = vi.fn().mockResolvedValue([]);
    tradovateStub(tradovateSearch);

    const lookup = createOpenPositionLookup();
    await lookup(TOPSTEP_ACCOUNT);
    await lookup(TRADOVATE_ACCOUNT);

    expect(topstepSearch).toHaveBeenCalledWith(TOPSTEP_ACCOUNT);
    expect(tradovateSearch).toHaveBeenCalledWith(TRADOVATE_ACCOUNT);
  });

  it("hits the broker once per account across repeat calls", async () => {
    const search = vi.fn().mockResolvedValue([]);
    stubTopstep(search);

    const lookup = createOpenPositionLookup();
    await lookup(TOPSTEP_ACCOUNT);
    await lookup(TOPSTEP_ACCOUNT);
    await lookup(TOPSTEP_ACCOUNT);

    expect(search).toHaveBeenCalledTimes(1);
  });

  it("caches the failure too, so a down broker is hit once and every leg fails closed", async () => {
    const search = vi.fn().mockRejectedValue(new Error("upstream 503"));
    stubTopstep(search);

    const lookup = createOpenPositionLookup();
    await expect(lookup(TOPSTEP_ACCOUNT)).rejects.toThrow("upstream 503");
    await expect(lookup(TOPSTEP_ACCOUNT)).rejects.toThrow("upstream 503");

    expect(search).toHaveBeenCalledTimes(1);
  });
});

/**
 * The composition the three group routes run verbatim. Route handlers
 * themselves need `getDb()` and stay out of scope per
 * docs/modules/testing/patterns.md, so the gate is exercised at the seam
 * they both call.
 */
describe("group open-position gate with the engine down", () => {
  const TRADOVATE_LEG = {
    id: "leg-1",
    accountId: TRADOVATE_ACCOUNT,
    contractId: "MNQM6",
  };

  // Calls the shipped predicate, not a copy of it. These helpers used to
  // inline their own `if (!contractId) … positions.some(…)`, which meant
  // they asserted the old copy-pasted logic and would have passed no
  // matter what the real gate did — including through the Critical where
  // it answered "flat" for every leg.
  function gate(leg: { accountId: number }) {
    const lookup = createOpenPositionLookup();
    return legHasOpenPositionWithFallback(undefined, () =>
      hasOpenPositionOnBroker(lookup, leg),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stubTopstep(vi.fn().mockResolvedValue([]));
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    routeByAccount();
  });

  it("sees a Tradovate leg's open position instead of Topstep's empty answer", async () => {
    tradovateStub(
      vi.fn().mockResolvedValue([
        { id: 7, accountId: TRADOVATE_ACCOUNT, contractId: "MNQM6", size: 1 },
      ]),
    );

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(true);
  });

  it("lets a flat Tradovate leg through", async () => {
    tradovateStub(vi.fn().mockResolvedValue([]));

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(false);
  });

  it("fails closed when the Tradovate client is unavailable", async () => {
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(true);
  });

  it("fails closed when the broker search throws", async () => {
    tradovateStub(vi.fn().mockRejectedValue(new Error("upstream 503")));

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(true);
  });

  it("fails closed on an untagged account rather than asking Topstep", async () => {
    // The refresh's Tradovate arm threw, so a Tradovate account never got
    // tagged. Defaulting it to Topstep gets `positions: []` back and opens
    // the gate on a live position.
    tradovateConfigured();
    const topstepSearch = vi.fn().mockResolvedValue([]);
    stubTopstep(topstepSearch);

    await expect(gate({ accountId: UNTAGGED_ACCOUNT })).resolves.toBe(true);
    expect(topstepSearch).not.toHaveBeenCalled();
  });

  // The Critical: `deployment.contract_id` is null on every row that has
  // ever existed, and the gate used to short-circuit on it before asking
  // any broker. A leg carrying no contract must still be refused when its
  // account holds a position — this is the regression test for the whole
  // fix, and it is why the subject type no longer has a `contractId`.
  it("blocks a leg that carries no contractId when its account holds a position", async () => {
    tradovateStub(
      vi.fn().mockResolvedValue([
        { id: 7, accountId: TRADOVATE_ACCOUNT, contractId: "MNQM6", size: 1 },
      ]),
    );

    await expect(gate({ accountId: TRADOVATE_ACCOUNT })).resolves.toBe(true);
  });

  // The accepted cost of account scope. Stated as a test so a future
  // reader finds the trade deliberate rather than assuming a bug and
  // narrowing the gate back to a contract comparison.
  it("blocks a leg whose account holds a position on an unrelated contract", async () => {
    tradovateStub(
      vi.fn().mockResolvedValue([
        { id: 9, accountId: TRADOVATE_ACCOUNT, contractId: "ESM6", size: 1 },
      ]),
    );

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(true);
  });

  // With account scope, a broker echoing rows for accounts nobody asked
  // about would block every gate on this account. Only rows naming a
  // *different* account are dropped; a row with no `accountId` is an
  // unknown and stays in, because unknowns fail closed here.
  it("ignores positions belonging to another account", async () => {
    tradovateStub(
      vi.fn().mockResolvedValue([
        { id: 11, accountId: TRADOVATE_ACCOUNT + 1, contractId: "MNQM6", size: 1 },
      ]),
    );

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(false);
  });

  it("keeps a position whose accountId is missing rather than dropping it", async () => {
    tradovateStub(vi.fn().mockResolvedValue([{ id: 12, contractId: "MNQM6", size: 1 }]));

    await expect(gate(TRADOVATE_LEG)).resolves.toBe(true);
  });
});

/**
 * The boot-engine session-migration pre-flight. `runPendingSessionMigrations`
 * migrates a row only when `hasOpenPosition` resolves false — it treats a
 * throw as "in position" and leaves the row intact — so "not migrated as
 * clean" is "resolves true, or throws".
 */
describe("session-migration pre-flight position check", () => {
  const TRADOVATE_DEPLOYMENT = {
    id: "depl-1",
    accountId: TRADOVATE_ACCOUNT,
    contractId: "MNQM6",
  };

  function hasOpenPosition(
    topstepSearch: ReturnType<typeof vi.fn>,
    d: { id: string; accountId: number },
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lookup = createBootOpenPositionLookup({ searchOpenPositions: topstepSearch } as any);
    return hasOpenPositionOnBroker(lookup, d);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readTradovateCredentialsFromDb).mockReturnValue(null);
    routeByAccount();
  });

  it("does not migrate a Tradovate deployment holding an open position", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([]);
    tradovateStub(
      vi.fn().mockResolvedValue([
        { id: 7, accountId: TRADOVATE_ACCOUNT, contractId: "MNQM6", size: 1 },
      ]),
    );

    await expect(hasOpenPosition(topstepSearch, TRADOVATE_DEPLOYMENT)).resolves.toBe(true);
    expect(topstepSearch).not.toHaveBeenCalled();
  });

  it("migrates a flat Tradovate deployment", async () => {
    tradovateStub(vi.fn().mockResolvedValue([]));

    await expect(
      hasOpenPosition(vi.fn().mockResolvedValue([]), TRADOVATE_DEPLOYMENT),
    ).resolves.toBe(false);
  });

  it("throws rather than migrating when the Tradovate client is unavailable", async () => {
    vi.mocked(getTradovateClientIfConfigured).mockResolvedValue(null);

    await expect(
      hasOpenPosition(vi.fn().mockResolvedValue([]), TRADOVATE_DEPLOYMENT),
    ).rejects.toThrow(/Tradovate client unavailable/);
  });

  it("throws rather than migrating when the position search fails", async () => {
    const topstepSearch = vi.fn().mockRejectedValue(new Error("upstream 503"));

    await expect(
      hasOpenPosition(topstepSearch, { id: "depl-2", accountId: TOPSTEP_ACCOUNT }),
    ).rejects.toThrow("upstream 503");
  });

  it("throws rather than migrating an untagged deployment while Tradovate is configured", async () => {
    tradovateConfigured();
    const topstepSearch = vi.fn().mockResolvedValue([]);

    await expect(
      hasOpenPosition(topstepSearch, { id: "depl-4", accountId: UNTAGGED_ACCOUNT }),
    ).rejects.toThrow(/no broker tag/);
    expect(topstepSearch).not.toHaveBeenCalled();
  });

  it("checks a Topstep deployment against the passed-in Topstep client", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([
      { id: 1, accountId: TOPSTEP_ACCOUNT, contractId: "CON.F.US.MNQ.M26", size: 1 },
    ]);

    await expect(
      hasOpenPosition(topstepSearch, { id: "depl-3", accountId: TOPSTEP_ACCOUNT }),
    ).resolves.toBe(true);
    expect(getTradovateClientIfConfigured).not.toHaveBeenCalled();
  });

  // E3 made the Topstep client nullable. `null` is what a Tradovate-only
  // install passes, and it is the last thing between that install and
  // migrating a row that holds a live position — so both arms of the null
  // branch are pinned here. If a future edit turns the throw into
  // `return []`, the first of these fails.
  describe("with no Topstep client (Tradovate-only install)", () => {
    it("throws rather than migrating a Topstep-routed account", async () => {
      const lookup = createBootOpenPositionLookup(null);

      await expect(
        hasOpenPositionOnBroker(lookup, { accountId: TOPSTEP_ACCOUNT }),
      ).rejects.toThrow(/routes to Topstep but no Topstep client is configured/);
    });

    it("still routes a Tradovate account to Tradovate", async () => {
      const search = vi
        .fn()
        .mockResolvedValue([
          { id: 9, accountId: TRADOVATE_ACCOUNT, contractId: "MNQM6", size: 1 },
        ]);
      tradovateStub(search);
      const lookup = createBootOpenPositionLookup(null);

      await expect(
        hasOpenPositionOnBroker(lookup, { accountId: TRADOVATE_ACCOUNT }),
      ).resolves.toBe(true);
      expect(search).toHaveBeenCalledWith(TRADOVATE_ACCOUNT);
    });
  });
});
