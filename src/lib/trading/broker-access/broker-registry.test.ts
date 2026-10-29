/**
 * `BrokerRegistry.refresh()` is one of three sites that seed
 * `account_brokers` — the table the live-account auto-trade block
 * classifies from. It seeds best-effort: a SQLite failure logs and the
 * refresh still returns, because the in-memory maps are already committed
 * by that point and throwing would discard a good fan-out *and* skip
 * `notifyRefreshFailures`, silencing a broker outage over an unrelated
 * write error.
 *
 * That shape is exactly the one `docs/modules/testing/patterns.md` warns
 * about: a best-effort `try`/`catch` means a throwing `getDb` no longer
 * enforces anything, so deleting the seed leaves the suite green. Mock the
 * DB module at its own seam and assert the call — both that it happens
 * with the right shape and that a failure does not take the refresh down.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() called in test — DB not available");
  }),
  registerMigration: vi.fn(),
}));

const { setAccountBrokers, markAccountsActive } = vi.hoisted(() => ({
  setAccountBrokers: vi.fn(),
  markAccountsActive: vi.fn(),
}));

vi.mock("@/lib/db/account-brokers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/account-brokers")>();
  return {
    ...actual,
    setAccountBrokers,
    markAccountsActive,
    getAccountBrokerOrTopstep: vi.fn(),
    listAccountIdsForBroker: vi.fn(() => []),
  };
});

vi.mock("@/lib/db/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/settings")>();
  return { ...actual, getTradovateApiCid: vi.fn(() => null) };
});
vi.mock("@/lib/db/deployments", () => ({ listManagedDeployments: vi.fn(() => []) }));
const { sendDiscordAlert } = vi.hoisted(() => ({
  sendDiscordAlert: vi.fn(
    async (_payload: { fields?: { name: string; value: string }[] }): Promise<AlertDelivery> =>
      "sent",
  ),
}));
vi.mock("@/lib/notify/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/discord")>()),
  sendDiscordAlert,
}));
vi.mock("@/lib/brokers/topstep/client", () => ({ TopstepClient: vi.fn() }));
vi.mock("@/lib/brokers/tradovate/client", () => ({ TradovateClient: vi.fn() }));

import { BrokerRegistry, TradovateAlertEpisode, notifyRefreshFailures } from "./broker-registry";
import { BrokerKind } from "@/lib/db/account-brokers";
import { getTradovateApiCid } from "@/lib/db/settings";
import { attributeAbsentAccount } from "@/lib/trading/engine/realtime/orphan-attribution";
import { accountStatusFanOutOf } from "@/lib/trading/engine/engine-account-status";
import { log } from "@/lib/logger";
import { eventSpec } from "@/lib/logging/vocabulary";
import type { Account } from "@/lib/brokers/types";
import type { AlertDelivery } from "@/lib/notify/discord";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";

/** The real name Topstep issued, per docs/bugs.md:840 — a Combine. */
const COMBINE: Account = {
  id: 5001,
  name: "50KTC-V2-100200-90020038",
  balance: 50_000,
  canTrade: true,
  isVisible: true,
  broker: "topstep",
  practice: false,
};

/** A Tradovate demo account, id-disjoint from the Topstep one above. */
const TRADOVATE: Account = {
  id: 7002,
  name: "DEMO2284917",
  balance: 25_000,
  canTrade: true,
  isVisible: true,
  broker: "tradovate",
  practice: true,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registryWithTopstep(searchAccounts: ReturnType<typeof vi.fn>): BrokerRegistry {
  return new BrokerRegistry({
    topstep: { searchAccounts } as any,
    tradovate: null,
  });
}

/** Both arms configured, each backed by its own `searchAccounts` spy so a
 *  test can fail one arm and leave the other answering. */
function registryWithBoth(
  topstepSearch: ReturnType<typeof vi.fn>,
  tradovateSearch: ReturnType<typeof vi.fn>,
): BrokerRegistry {
  return new BrokerRegistry({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    topstep: { searchAccounts: topstepSearch } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tradovate: { searchAccounts: tradovateSearch } as any,
  });
}

/** Which client the registry would hand an order for this account, identified
 *  by the `searchAccounts` spy each fake broker was built around. Reads the
 *  registry's own accessor — the map an order actually routes through, not the
 *  kind tag beside it. */
function brokerBehind(registry: BrokerRegistry, accountId: number): unknown {
  return (registry.get(accountId) as unknown as { searchAccounts: unknown } | null)?.searchAccounts;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTradovateApiCid).mockReturnValue(null);
});

describe("BrokerRegistry.refresh — account_brokers seeding", () => {
  it("seeds the fan-out it just committed, with the classified fields", async () => {
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    await registry.refresh();

    expect(setAccountBrokers).toHaveBeenCalledTimes(1);
    expect(setAccountBrokers).toHaveBeenCalledWith([
      {
        accountId: 5001,
        broker: "topstep",
        name: "50KTC-V2-100200-90020038",
        practice: false,
      },
    ]);
  });

  // The point of the best-effort arm. Before it, this threw through
  // refresh() and skipped notifyRefreshFailures downstream, so a DB hiccup
  // silenced a real broker outage.
  it("survives a seeding failure and still reports the refresh", async () => {
    setAccountBrokers.mockImplementation(() => {
      throw new Error("database is locked");
    });
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    const result = await registry.refresh();

    expect(result.partial).toBe(false);
    expect(result.errors.topstep).toBeNull();
    expect(result.size).toBe(1);
  });

  it("leaves the in-memory routing intact when seeding fails", async () => {
    setAccountBrokers.mockImplementation(() => {
      throw new Error("database is locked");
    });
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    await registry.refresh();

    // The maps are the runtime source of truth and are committed before the
    // seed runs — that ordering is why throwing was the wrong trade.
    expect(registry.has(5001)).toBe(true);
  });

  // A broker outage must still be reported as partial. The seed succeeding
  // does not make a failed arm succeed.
  it("reports a partial refresh when the broker arm fails", async () => {
    const registry = registryWithTopstep(vi.fn().mockRejectedValue(new Error("upstream 503")));

    const result = await registry.refresh();

    expect(result.partial).toBe(true);
    expect(result.errors.topstep).toContain("upstream 503");
  });
});

/**
 * Tradovate's search lists only accounts that can trade, so an id its
 * answering arm listed is an `ok` answer. Marking it on any refresh is what
 * heals a false "dead" within the reconciler's 30 minutes rather than at the
 * next daily check. **Topstep's listed ids are never marked**: its active-only
 * search still lists failed and ineligible accounts, so marking them would
 * revive a dead account on every refresh.
 */
describe("BrokerRegistry.refresh — the balances it carries", () => {
  it("carries Topstep's finite balances, leaves a non-finite one out, and never Tradovate's", async () => {
    const broken: Account = { ...COMBINE, id: 5002, balance: Number.NaN };
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE, broken]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );

    const result = await registry.refresh();

    expect(result.balances.topstep).toEqual(new Map([[COMBINE.id, 50_000]]));
    expect(result.balances.tradovate).toBeNull();
  });

  it("carries none for a Topstep arm that failed", async () => {
    const registry = registryWithTopstep(vi.fn().mockRejectedValue(new Error("upstream 503")));
    expect((await registry.refresh()).balances.topstep).toBeNull();
  });
});

describe("BrokerRegistry.refresh — Tradovate's listed accounts are recorded ok", () => {
  it("marks the ids Tradovate listed, and none a failed arm carried forward", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();
    expect(markAccountsActive.mock.calls.map((c) => c[0])).toEqual([[TRADOVATE.id]]);
    markAccountsActive.mockClear();

    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
    const result = await registry.refresh();

    expect(markAccountsActive).not.toHaveBeenCalled();
    expect(result.answeredAt.tradovate).toBeNull();
  });

  it("never marks a Topstep id, though its arm answered", async () => {
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));
    const result = await registry.refresh();
    expect(result.listed.topstep).toEqual([COMBINE.id]);
    expect(markAccountsActive).not.toHaveBeenCalled();
  });

  it("writes nothing when every arm failed", async () => {
    const registry = registryWithTopstep(vi.fn().mockRejectedValue(new Error("upstream 503")));
    await registry.refresh();
    expect(markAccountsActive).not.toHaveBeenCalled();
  });

  it("carries each answering arm's canTrade-false ids, for the status check's fallback", async () => {
    const blown = { ...COMBINE, id: 5002, canTrade: false };
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE, blown]),
      vi.fn().mockRejectedValue(new Error("tradovate 401")),
    );
    const result = await registry.refresh();
    expect(result.cannotTrade).toEqual({ topstep: [blown.id], tradovate: null });
  });

  // The write lands after the slowest arm, and a status check may record an
  // account dead while it waits. Stamped with the refresh's end, the answer
  // would read as the newer one and revive that account; the writer's guard
  // only holds if each answer carries the time it was given.
  it("stamps each arm's answer with the time that arm's search returned", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-10-14T21:00:00.000Z");
      vi.setSystemTime(t0);
      let releaseTradovate: (accounts: Account[]) => void = () => {};
      const tradovateSearch = vi.fn(
        () => new Promise<Account[]>((resolve) => (releaseTradovate = resolve)),
      );
      const registry = registryWithBoth(vi.fn().mockResolvedValue([COMBINE]), tradovateSearch);

      const pending = registry.refresh();
      // The Tradovate search starts only once the Topstep answer is taken.
      while (tradovateSearch.mock.calls.length === 0) await Promise.resolve();
      vi.setSystemTime(t0.getTime() + 60_000);
      releaseTradovate([TRADOVATE]);
      const result = await pending;

      const later = new Date(t0.getTime() + 60_000).toISOString();
      expect(markAccountsActive.mock.calls).toEqual([[[TRADOVATE.id], later]]);
      expect(result.answeredAt).toEqual({ topstep: t0.toISOString(), tradovate: later });
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives the write failing, like the seed beside it", async () => {
    markAccountsActive.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );

    const result = await registry.refresh();

    expect(markAccountsActive).toHaveBeenCalledTimes(1);
    expect(result.errors.tradovate).toBeNull();
    expect(registry.has(TRADOVATE.id)).toBe(true);
  });
});

/**
 * `RefreshResult.listed` is each arm's answer, fixed when `refresh()` returns.
 * A reader that took the ids from the live registry instead saw whatever a
 * later, concurrent refresh left there — one with no Tradovate client empties
 * the Tradovate entries, and the status check then recorded every Tradovate
 * account inactive.
 */
describe("BrokerRegistry.refresh — each arm's answer is carried in the result", () => {
  it("lists what each answering arm returned, and null for an arm that did not answer", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockRejectedValue(new Error("tradovate 401")),
    );

    const result = await registry.refresh();

    expect(result.listed).toEqual({ topstep: [COMBINE.id], tradovate: null });
  });

  it("reads an arm that was never run as null, not as an empty answer", async () => {
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([]));

    const result = await registry.refresh();

    // Topstep answered "none"; Tradovate is not configured and said nothing.
    expect(result.listed).toEqual({ topstep: [], tradovate: null });
    expect(result.errors.tradovate).toBeNull();
  });

  it("keeps a result's answer when a later refresh with no Tradovate client empties the registry", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );
    const first = await registry.refresh();

    // The concurrent refresh: credentials dropped under a running engine.
    vi.mocked(getTradovateApiCid).mockReturnValue("cid-123");
    registry.updateTradovateClient(null);
    await registry.refresh();
    expect(registry.accountIdsForKind(BrokerKind.Tradovate)).toEqual([]);

    const fanOut = accountStatusFanOutOf(first);
    expect(fanOut.answered.get(BrokerKind.Tradovate)?.ids).toEqual([TRADOVATE.id]);
    expect(fanOut.answered.get(BrokerKind.Topstep)?.ids).toEqual([COMBINE.id]);
  });
});

/**
 * The 2026-08-26 mis-routing incident (docs/bugs.md, "One leg of a group
 * flattens at session end and its sibling does not"): a fan-out where one arm
 * threw replaced all three maps unconditionally, so a transient outage erased
 * one broker's whole account set from the registry that decides where every
 * order goes.
 */
describe("BrokerRegistry.refresh — a partially failed fan-out", () => {
  it("keeps the failed arm's previous entries instead of erasing them", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
    const result = await registry.refresh();

    expect(result.errors.topstep).toContain("upstream 503");
    // The account the failed arm reported last time is still routable and
    // still tagged Topstep — nothing falls through to the persisted default.
    expect(registry.has(COMBINE.id)).toBe(true);
    expect(registry.accountIdsForKind(BrokerKind.Topstep)).toContain(COMBINE.id);
    expect(registry.accountNamesSnapshot().get(COMBINE.id)).toBe(COMBINE.name);
  });

  it("leaves the healthy arm's mappings intact when the other throws", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
    await registry.refresh();

    expect(registry.accountIdsForKind(BrokerKind.Tradovate)).toContain(TRADOVATE.id);
    expect(registry.accountIdsForKind(BrokerKind.Topstep)).toContain(COMBINE.id);
  });

  // An outage is not evidence about the accounts it failed to report, so the
  // durable table only ever hears from an arm that answered.
  it("persists only the accounts the answering arm returned", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();
    setAccountBrokers.mockClear();

    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
    await registry.refresh();

    expect(setAccountBrokers).toHaveBeenCalledTimes(1);
    expect(setAccountBrokers).toHaveBeenCalledWith([
      { accountId: COMBINE.id, broker: "topstep", name: COMBINE.name, practice: false },
    ]);
  });

  it("writes nothing at all when every arm failed", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();
    setAccountBrokers.mockClear();

    topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
    await registry.refresh();

    expect(setAccountBrokers).not.toHaveBeenCalled();
  });

  // A carried-forward account is not a missing account. Reporting it as
  // removed is what routes it through the engine's orphan path on a blip.
  it("does not report a carried-forward account as removed", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
    const result = await registry.refresh();

    expect(result.removed).toEqual([]);
  });

  // An account genuinely gone from a *successful* arm still drops out.
  it("still drops an account the answering arm stopped reporting", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    tradovateSearch.mockResolvedValueOnce([]);
    const result = await registry.refresh();

    expect(result.removed).toEqual([TRADOVATE.id]);
    expect(registry.has(TRADOVATE.id)).toBe(false);
  });

  // The fixtures above are id-disjoint, so they cannot see the ordering: the
  // Tradovate catch arm runs *after* the Topstep success loop, and a
  // carry-forward that writes unconditionally re-routes an id Topstep just
  // answered for. One id, both arms, two refreshes.
  it("does not let a failed arm's carry-forward overwrite an id the other arm just claimed", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([]);
    const tradovateSearch = vi.fn().mockResolvedValue([{ ...COMBINE, broker: "tradovate" }]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();
    expect(registry.brokerKind(COMBINE.id)).toBe(BrokerKind.Tradovate);

    // The account moved to Topstep, and Tradovate is down this pass.
    topstepSearch.mockResolvedValueOnce([COMBINE]);
    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 503"));
    const result = await registry.refresh();

    expect(registry.brokerKind(COMBINE.id)).toBe(BrokerKind.Topstep);
    expect(registry.accountIdsForKind(BrokerKind.Tradovate)).not.toContain(COMBINE.id);
    // The routing map is the one that decides which contract every order
    // carries, so it has to move too — not just the kind tag.
    expect((registry.get(COMBINE.id) as unknown as { searchAccounts: unknown }).searchAccounts).toBe(
      topstepSearch,
    );
    // And the re-route has to be reported: `kindChanges` is what puts it on
    // the durable log.
    expect(result.kindChanges).toEqual([
      {
        accountId: COMBINE.id,
        from: BrokerKind.Tradovate,
        to: BrokerKind.Topstep,
        name: COMBINE.name,
      },
    ]);
  });

  it("still carries an id forward when no answering arm claimed it", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([]);
    const tradovateSearch = vi.fn().mockResolvedValue([{ ...COMBINE, broker: "tradovate" }]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 503"));
    await registry.refresh();

    expect(registry.brokerKind(COMBINE.id)).toBe(BrokerKind.Tradovate);
    expect(registry.accountNamesSnapshot().get(COMBINE.id)).toBe(COMBINE.name);
  });

  // "Some broker answered" is not "the registry is current".
  it("does not age-stamp a refresh that one arm failed", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockRejectedValue(new Error("tradovate 401"));
    const registry = registryWithBoth(topstepSearch, tradovateSearch);

    await registry.refresh();

    expect(registry.ageMs()).toBe(Infinity);
  });

  it("age-stamps a refresh in which every configured arm answered", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );

    await registry.refresh();

    expect(registry.ageMs()).toBeLessThan(1000);
  });
});

/**
 * A76: a credential change whose re-login fails on the network keeps the new,
 * unauthenticated client, so the Tradovate arm throws and carries its accounts
 * forward. The carried entries must route through that kept client — the one
 * the engine and the realtime adapter hold — never the instance the plugin
 * dropped, which still holds the previous credentials' token.
 */
describe("BrokerRegistry.updateTradovateClient — one Tradovate client per process", () => {
  it("A76: after a swap whose refresh throws, get(id) answers with the new client, not the dropped one", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const droppedSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, droppedSearch);
    await registry.refresh();

    const keptSearch = vi.fn().mockRejectedValue(new Error("fetch failed"));
    registry.updateTradovateClient({ searchAccounts: keptSearch } as unknown as TradovateClient);
    const result = await registry.refresh();

    expect(result.errors.tradovate).toContain("fetch failed");
    expect(brokerBehind(registry, TRADOVATE.id)).toBe(keptSearch);
    // The other broker's routing is not the swap's business.
    expect(brokerBehind(registry, COMBINE.id)).toBe(topstepSearch);
  });

  it("A76: the swap rebinds at once, before any refresh runs", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );
    await registry.refresh();

    const keptSearch = vi.fn();
    registry.updateTradovateClient({ searchAccounts: keptSearch } as unknown as TradovateClient);

    expect(brokerBehind(registry, TRADOVATE.id)).toBe(keptSearch);
  });
});

/**
 * A broker-kind change on an account that was already mapped re-routes every
 * subsequent order for it. The 2026-08-26 incident took a night to localise
 * because nothing recorded that it happened.
 */
describe("BrokerRegistry.refresh — broker-kind changes", () => {
  it("reports an account whose broker kind changed", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    topstepSearch.mockResolvedValueOnce([]);
    tradovateSearch.mockResolvedValueOnce([{ ...COMBINE, broker: "tradovate" }]);
    const result = await registry.refresh();

    expect(result.kindChanges).toEqual([
      {
        accountId: COMBINE.id,
        from: BrokerKind.Topstep,
        to: BrokerKind.Tradovate,
        name: COMBINE.name,
      },
    ]);
  });

  it("says nothing about an account appearing for the first time", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );

    const result = await registry.refresh();

    expect(result.kindChanges).toEqual([]);
  });

  it("says nothing when the mapping is unchanged", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );
    await registry.refresh();

    const result = await registry.refresh();

    expect(result.kindChanges).toEqual([]);
  });

  // A carried-forward entry is the previous answer, not a new one.
  it("says nothing when an arm failed and its entries were carried forward", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();

    topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
    const result = await registry.refresh();

    expect(result.kindChanges).toEqual([]);
  });

  // `kindChanges` is the durable-log half. The map is the half that decides
  // which contract every subsequent order carries, and the two are written
  // from different variables — a re-route reported but not applied, or applied
  // but not reported, are both silent in the other's test.
  it("moves the routing map, not only the tag, when both arms answer the change", async () => {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();
    expect(brokerBehind(registry, COMBINE.id)).toBe(topstepSearch);

    topstepSearch.mockResolvedValueOnce([]);
    tradovateSearch.mockResolvedValueOnce([{ ...COMBINE, broker: "tradovate" }]);
    await registry.refresh();

    expect(registry.brokerKind(COMBINE.id)).toBe(BrokerKind.Tradovate);
    expect(brokerBehind(registry, COMBINE.id)).toBe(tradovateSearch);
    expect(registry.accountIdsForKind(BrokerKind.Topstep)).not.toContain(COMBINE.id);
  });
});

/**
 * The distinction the carry-forward rule turns on.
 *
 * An arm that resolves `[]` has *answered*: it was asked which accounts it
 * owns and said none. An arm that throws has said nothing at all. Carrying
 * forward on the first is how a genuinely-closed account stays routable
 * forever; not carrying forward on the second is how a 30-second outage drops
 * every account through to `getAccountBrokerOrTopstep` and hands a Tradovate
 * position a Topstep contract.
 *
 * The two cases below are deliberately the same account, the same arm and the
 * same starting registry, so the only variable is which of the two answers the
 * arm gave.
 */
describe("BrokerRegistry.refresh — an empty answer is an answer, a throw is not", () => {
  async function seeded() {
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([TRADOVATE]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);
    await registry.refresh();
    return { registry, topstepSearch, tradovateSearch };
  }

  it("drops the account when the arm answers with an empty list", async () => {
    const { registry, topstepSearch } = await seeded();

    topstepSearch.mockResolvedValueOnce([]);
    const result = await registry.refresh();

    expect(registry.has(COMBINE.id)).toBe(false);
    expect(registry.accountIdsForKind(BrokerKind.Topstep)).not.toContain(COMBINE.id);
    expect(result.removed).toEqual([COMBINE.id]);
  });

  it("keeps the same account when the same arm throws instead", async () => {
    const { registry, topstepSearch } = await seeded();

    topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
    const result = await registry.refresh();

    expect(registry.has(COMBINE.id)).toBe(true);
    expect(registry.accountIdsForKind(BrokerKind.Topstep)).toContain(COMBINE.id);
    expect(result.removed).toEqual([]);
  });

  // A blip that takes out both credentials at once — a DNS failure, an expired
  // container secret — must not empty the whole routing table. Nothing here is
  // evidence about any account.
  it("keeps both routing tables when every arm throws in the same pass", async () => {
    const { registry, topstepSearch, tradovateSearch } = await seeded();

    topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
    tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
    const result = await registry.refresh();

    expect(brokerBehind(registry, COMBINE.id)).toBe(topstepSearch);
    expect(brokerBehind(registry, TRADOVATE.id)).toBe(tradovateSearch);
    expect(registry.brokerKind(COMBINE.id)).toBe(BrokerKind.Topstep);
    expect(registry.brokerKind(TRADOVATE.id)).toBe(BrokerKind.Tradovate);
    expect(registry.accountNamesSnapshot().get(TRADOVATE.id)).toBe(TRADOVATE.name);
    expect(result.removed).toEqual([]);
    // Nothing moved, so nothing is reported as having moved — a total outage
    // that manufactured `kindChanges` would put a false re-route on the
    // durable log, which is the log an operator localises an incident from.
    expect(result.kindChanges).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.errors.topstep).toContain("upstream 503");
    expect(result.errors.tradovate).toContain("tradovate 401");
  });

  // The staleness clock is what a caller reads to decide whether the routing
  // table can be trusted. A pass in which nothing answered must not restart
  // it — carried-forward entries are exactly as old as the refresh that
  // produced them.
  it("does not restart the staleness clock on a pass every arm failed", async () => {
    vi.useFakeTimers();
    try {
      const { registry, topstepSearch, tradovateSearch } = await seeded();

      vi.advanceTimersByTime(60_000);
      topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
      tradovateSearch.mockRejectedValueOnce(new Error("tradovate 401"));
      await registry.refresh();

      expect(registry.ageMs()).toBeGreaterThanOrEqual(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // A carry-forward is a stay of execution, not a pardon.
  it("drops a carried-forward account once its arm answers again without it", async () => {
    const { registry, topstepSearch } = await seeded();

    topstepSearch.mockRejectedValueOnce(new Error("upstream 503"));
    await registry.refresh();
    expect(registry.has(COMBINE.id)).toBe(true);

    topstepSearch.mockResolvedValueOnce([]);
    const result = await registry.refresh();

    expect(registry.has(COMBINE.id)).toBe(false);
    expect(result.removed).toEqual([COMBINE.id]);
  });

  /**
   * Both arms claiming one id in a single refresh is a credential or
   * environment mix-up — ids are broker-scoped in practice. Whatever the
   * cause, the id must end up owned by exactly one broker: an account routed
   * to the wrong client gets the wrong contract on every order, and a routing
   * map that disagreed with the kind tag would send the order and the
   * contract to different brokers.
   */
  it("routes an id both arms claim to exactly one broker, loudly", async () => {
    const logged = vi.spyOn(log, "event").mockImplementation(() => {});
    const topstepSearch = vi.fn().mockResolvedValue([COMBINE]);
    const tradovateSearch = vi.fn().mockResolvedValue([{ ...COMBINE, broker: "tradovate" }]);
    const registry = registryWithBoth(topstepSearch, tradovateSearch);

    await registry.refresh();

    expect(registry.brokerKind(COMBINE.id)).toBe(BrokerKind.Tradovate);
    expect(brokerBehind(registry, COMBINE.id)).toBe(tradovateSearch);
    expect(registry.accountIdsForKind(BrokerKind.Topstep)).not.toContain(COMBINE.id);
    // A silent collision is the failure mode: the account routes somewhere,
    // the operator has no reason to look, and the credential mix-up persists.
    // The id has to be in the *message*, not only in the subject column —
    // that is the half an operator reads.
    expect(
      logged.mock.calls.some(
        (c) => c[0] === "account_id_collision" && String(c[2]).includes(String(COMBINE.id)),
      ),
    ).toBe(true);
    // "Loudly" was `log.error` before the line named an event. The severity
    // now belongs to the registry, so it is pinned there; without this the
    // assertion above holds for a collision filed at `info`.
    expect(eventSpec("account_id_collision")?.severity).toBe("error");
    logged.mockRestore();
  });
});

/**
 * A74's Tradovate door. A first login that fails nulls the plugin's client, so
 * the engine is built with `tradovate: null` — and a registry that read that as
 * "unconfigured" reported a clean fan-out, so every orphan cross-check paused
 * the cash account's deployments off a broker nobody could ask.
 */
describe("BrokerRegistry.refresh — an expected broker with no client is a failed arm", () => {
  function expectTradovate(): void {
    vi.mocked(getTradovateApiCid).mockReturnValue("cid-123");
  }

  it("reports the Tradovate arm as failed on a cold boot whose first login failed", async () => {
    expectTradovate();
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    const result = await registry.refresh();

    expect(result.partial).toBe(true);
    expect(result.errors.tradovate).not.toBeNull();
    expect(result.errors.topstep).toBeNull();
  });

  it("makes the orphan cross-check skip a persisted Tradovate account, and still orphan a Topstep one", async () => {
    expectTradovate();
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    const result = await registry.refresh();

    expect(attributeAbsentAccount(BrokerKind.Tradovate, result).decision).toBe("skip");
    expect(attributeAbsentAccount(BrokerKind.Topstep, result).decision).toBe("orphan");
  });

  it("treats Tradovate as unconfigured, as before, when it is not expected", async () => {
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    const result = await registry.refresh();

    expect(result.partial).toBe(false);
    expect(result.errors.tradovate).toBeNull();
    expect(attributeAbsentAccount(BrokerKind.Tradovate, result).decision).toBe("orphan");
  });

  it("does not age-stamp a refresh an expected broker could not answer", async () => {
    expectTradovate();
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    await registry.refresh();

    expect(registry.ageMs()).toBe(Infinity);
  });

  /**
   * The expectation is two DB reads, so it can fail to answer at all — and
   * this arm decides *attribution*, not only whether to alert. A DB error read
   * as "not expected" leaves `errors.tradovate` null, every cross-check reads
   * the skipped arm as an answer, and Tradovate accounts orphan one way: A74
   * again, through the fix for it.
   */
  it("reads a DB error as expected, so a skipped arm never passes for an answer", async () => {
    vi.mocked(getTradovateApiCid).mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    const registry = registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]));

    const result = await registry.refresh();

    expect(result.errors.tradovate).not.toBeNull();
    expect(result.partial).toBe(true);
    expect(attributeAbsentAccount(BrokerKind.Tradovate, result).decision).toBe("skip");
    // The Topstep arm answered and keeps detecting — the fail-closed read is
    // scoped to the arm that could not be asked about.
    expect(attributeAbsentAccount(BrokerKind.Topstep, result).decision).toBe("orphan");
  });

  // The previous entries hold the client the plugin just dropped — creds
  // removed or rotated. Carrying them forward would keep routing orders
  // through it, which a thrown search never does: its client is still live.
  it("does not keep routing a warm registry's accounts through a dropped client", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockResolvedValue([TRADOVATE]),
    );
    await registry.refresh();
    expectTradovate();
    registry.updateTradovateClient(null);

    const result = await registry.refresh();

    expect(registry.has(TRADOVATE.id)).toBe(false);
    expect(result.errors.tradovate).not.toBeNull();
    expect(registry.has(COMBINE.id)).toBe(true);
  });
});

/**
 * The alert is the operator's only view of a failed Tradovate arm at 06:00, and
 * the two failures behind it are not the same event: a search that failed is a
 * broker outage, a null client is a login this process never completed — and
 * that one also means no order can reach Tradovate at all.
 */
describe("notifyRefreshFailures — the two Tradovate failures read differently", () => {
  /** The real `RefreshResult` for each case, so neither the error string nor
   *  the constant behind it is restated in this file. */
  async function refreshWith(tradovate: "no-client" | "search-threw"): Promise<{
    result: Awaited<ReturnType<BrokerRegistry["refresh"]>>;
  }> {
    vi.mocked(getTradovateApiCid).mockReturnValue("cid-123");
    const registry =
      tradovate === "no-client"
        ? registryWithTopstep(vi.fn().mockResolvedValue([COMBINE]))
        : registryWithBoth(
            vi.fn().mockResolvedValue([COMBINE]),
            vi.fn().mockRejectedValue(new Error("upstream 503")),
          );
    return { result: await registry.refresh() };
  }

  function alertField(name: string): string {
    const payload = sendDiscordAlert.mock.calls[0]?.[0];
    return payload?.fields?.find((f) => f.name === name)?.value ?? "";
  }

  it("says the arm was skipped, not that a search failed, when there is no client", async () => {
    const logged = vi.spyOn(log, "event").mockImplementation(() => {});
    const { result } = await refreshWith("no-client");

    await notifyRefreshFailures(result, new TradovateAlertEpisode());

    const line = String(
      logged.mock.calls.find((c) => c[0] === "boot_broker_arm_failed")?.[2] ?? "",
    );
    expect(line).toContain("no client");
    expect(line).not.toContain("searchAccounts failed");
    logged.mockRestore();
  });

  it("tells the operator no Tradovate order can be placed or closed until it is re-attached", async () => {
    // A search that failed leaves a live client and a working order path; a
    // null one does not, and an alert that only mentions orphan detection
    // understates an engine that cannot close an open position.
    vi.spyOn(log, "event").mockImplementation(() => {});
    const { result } = await refreshWith("no-client");

    await notifyRefreshFailures(result, new TradovateAlertEpisode());

    expect(alertField("Impact")).toContain("cannot place or close orders");
  });

  it("keeps the search wording, and the narrower impact, when the arm actually searched", async () => {
    const logged = vi.spyOn(log, "event").mockImplementation(() => {});
    const { result } = await refreshWith("search-threw");

    await notifyRefreshFailures(result, new TradovateAlertEpisode());

    const line = String(
      logged.mock.calls.find((c) => c[0] === "boot_broker_arm_failed")?.[2] ?? "",
    );
    expect(line).toContain("searchAccounts failed");
    expect(alertField("Impact")).not.toContain("cannot place or close orders");
    expect(alertField("Reason")).toContain("upstream 503");
    logged.mockRestore();
  });

  it("stays silent when the expectation read itself failed", async () => {
    // The alert half keeps its silent-on-error read: waking an operator over a
    // SQLite hiccup is the failure this predicate was written to avoid. The
    // attribution half does the opposite — see `refresh()`.
    vi.spyOn(log, "event").mockImplementation(() => {});
    const { result } = await refreshWith("no-client");
    vi.mocked(getTradovateApiCid).mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    await notifyRefreshFailures(result, new TradovateAlertEpisode());

    expect(sendDiscordAlert).not.toHaveBeenCalled();
  });
});

/**
 * The alert used to go out on every refresh that saw the arm fail — boot, the
 * 30-minute poll, every Settings visit and the hourly status retry — so one
 * outage was a stream of identical pages. It is once per episode now; a
 * refresh whose arm did not fail ends the episode.
 */
describe("notifyRefreshFailures — one alert per Tradovate outage", () => {
  beforeEach(() => {
    vi.spyOn(log, "event").mockImplementation(() => {});
    vi.mocked(getTradovateApiCid).mockReturnValue("cid-123");
  });
  afterEach(() => {
    vi.mocked(log.event).mockRestore();
  });

  function titles(): string[] {
    return sendDiscordAlert.mock.calls.map((c) => String((c[0] as { title?: string }).title));
  }

  it("alerts once however many refreshes see the same outage, and again for the next one", async () => {
    const tradovateSearch = vi.fn().mockRejectedValue(new Error("upstream 503"));
    const registry = registryWithBoth(vi.fn().mockResolvedValue([COMBINE]), tradovateSearch);
    const episode = new TradovateAlertEpisode();

    for (let i = 0; i < 3; i += 1) await notifyRefreshFailures(await registry.refresh(), episode);
    expect(titles()).toEqual(["Tradovate broker unavailable"]);
    // The durable line is still per refresh; only the page is throttled.
    expect(
      vi.mocked(log.event).mock.calls.filter((c) => c[0] === "boot_broker_arm_failed"),
    ).toHaveLength(3);

    // Answering ends the episode, quietly.
    tradovateSearch.mockResolvedValue([TRADOVATE]);
    await notifyRefreshFailures(await registry.refresh(), episode);
    expect(titles()).toHaveLength(1);

    tradovateSearch.mockRejectedValue(new Error("upstream 503"));
    await notifyRefreshFailures(await registry.refresh(), episode);
    expect(titles()).toEqual(["Tradovate broker unavailable", "Tradovate broker unavailable"]);
  });

  // The two failures carry different impacts — a null client means no order
  // reaches Tradovate at all — so moving from one to the other is news.
  it("alerts again when a failed search turns into a missing client", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockRejectedValue(new Error("upstream 503")),
    );
    const episode = new TradovateAlertEpisode();
    await notifyRefreshFailures(await registry.refresh(), episode);

    registry.updateTradovateClient(null);
    await notifyRefreshFailures(await registry.refresh(), episode);
    await notifyRefreshFailures(await registry.refresh(), episode);

    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  // The episode is claimed before the await so two refreshes landing together
  // page once. An alert that then failed to reach Discord announced nothing,
  // and a claim left standing would silence the rest of the outage.
  it("alerts again on the next refresh when the alert did not reach Discord", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockRejectedValue(new Error("upstream 503")),
    );
    const episode = new TradovateAlertEpisode();
    sendDiscordAlert.mockResolvedValueOnce("failed");

    await notifyRefreshFailures(await registry.refresh(), episode);
    await notifyRefreshFailures(await registry.refresh(), episode);
    await notifyRefreshFailures(await registry.refresh(), episode);

    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  it("alerts again when the send itself throws", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockRejectedValue(new Error("upstream 503")),
    );
    const episode = new TradovateAlertEpisode();
    sendDiscordAlert.mockRejectedValueOnce(new Error("settings cache unavailable"));

    await notifyRefreshFailures(await registry.refresh(), episode);
    await notifyRefreshFailures(await registry.refresh(), episode);

    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  // Notifications off is the operator's choice, not a lost page: retrying it on
  // every refresh would page the moment they turn alerts back on, for an
  // outage hours old.
  it("counts an alert the notifications switch silenced as announced", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockRejectedValue(new Error("upstream 503")),
    );
    const episode = new TradovateAlertEpisode();
    sendDiscordAlert.mockResolvedValueOnce("silenced");

    await notifyRefreshFailures(await registry.refresh(), episode);
    await notifyRefreshFailures(await registry.refresh(), episode);

    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("still pages once when two refreshes land together", async () => {
    const registry = registryWithBoth(
      vi.fn().mockResolvedValue([COMBINE]),
      vi.fn().mockRejectedValue(new Error("upstream 503")),
    );
    const episode = new TradovateAlertEpisode();
    const [a, b] = [await registry.refresh(), await registry.refresh()];

    await Promise.all([notifyRefreshFailures(a, episode), notifyRefreshFailures(b, episode)]);

    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
  });
});
