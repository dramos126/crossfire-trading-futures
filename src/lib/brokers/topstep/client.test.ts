/**
 * `TopstepClient.searchAccounts` is where `practice` is derived for every
 * Topstep account in the process — `isPracticeAccount`, `classifyAccount`
 * and the auto-trade block all read what it stamps and never look at the
 * name again. It was untested, so the prefix it matches on was pinned only
 * by helpers in other files that restated the rule.
 *
 * The names below are real, observed on the operator's own accounts and
 * recorded in docs/bugs.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  AccountNotFoundError,
  TopstepClient,
  TopstepHttpError,
  TopstepOrderRejectionError,
  UnauthorizedError,
  topstepSessionState,
} from "./client";
import { ContractResolver } from "./contract-resolver";
import { takeTopstepRequestWindow } from "./request-counter";
import { log } from "@/lib/logger";
import { eventSpec } from "@/lib/logging/vocabulary";
import type { Account, PlaceOrderRequest } from "@/lib/brokers/types";

vi.mock("@/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() },
}));

/** Only the two fields the stamping reads; the rest of the row passes
 *  through untouched. */
function stubAccountSearch(accounts: Array<{ id: number; name: string }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, accounts }),
    }),
  );
}

async function searchAccounts(names: string[]): Promise<Account[]> {
  stubAccountSearch(names.map((name, i) => ({ id: 1000 + i, name })));
  return new TopstepClient().searchAccounts();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(log.event).mockClear();
});

describe("TopstepClient.searchAccounts — practice stamping", () => {
  it("stamps a real practice account as practice", async () => {
    // docs/bugs.md:662
    const [account] = await searchAccounts(["PRAC-V2-100200-90012114"]);
    expect(account.practice).toBe(true);
  });

  it("does not stamp a real Combine account as practice", async () => {
    // docs/bugs.md:840
    const [account] = await searchAccounts(["50KTC-V2-100200-90020038"]);
    expect(account.practice).toBe(false);
  });

  it("does not stamp a real ExpressFunded account as practice", async () => {
    // docs/bugs.md:876
    const [account] = await searchAccounts(["EXPRESS-V2-CT-100200-90034064"]);
    expect(account.practice).toBe(false);
  });

  it("requires the hyphen — the prefix is not a bare word match", async () => {
    // Narrowing is the fail-closed direction: a name that misses the
    // prefix classifies LIVE and is refused, which is visible. The
    // opposite error auto-trades a funded account.
    const [account] = await searchAccounts(["PRACTICE-100200"]);
    expect(account.practice).toBe(false);
  });

  it("does not treat a mid-name PRAC- token as a practice account", async () => {
    const [account] = await searchAccounts(["FUNDED-PRAC-100200"]);
    expect(account.practice).toBe(false);
  });

  it("tags every row with the Topstep broker", async () => {
    const accounts = await searchAccounts([
      "PRAC-V2-100200-90012114",
      "50KTC-V2-100200-90020038",
    ]);
    expect(accounts.map((a) => a.broker)).toEqual(["topstep", "topstep"]);
  });

  it("throws when the gateway reports failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: false, errorMessage: "Invalid session" }),
      }),
    );
    await expect(new TopstepClient().searchAccounts()).rejects.toThrow("Invalid session");
  });
});

/**
 * The guard on /Contract/search sits under the engine's live contract
 * resolution — `ContractResolver.resolve` runs on the first line of every
 * `processDeployment`. A guard that refuses the whole list stops a
 * deployment evaluating bars over an element of a product it never wanted,
 * and the 15-minute resolver cache never populates, so every tick re-throws.
 */

/** One element in the shape Topstep puts on the wire. */
function contract(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id.split(".")[3] ?? id,
    description: `contract ${id}`,
    tickSize: 0.25,
    tickValue: 5,
    activeContract: true,
    symbolId: `F.US.${id.split(".")[3] ?? id}`,
    ...over,
  };
}

function stubContractSearch(contracts: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, contracts }),
    }),
  );
}

describe("TopstepClient.searchContracts — response guard", () => {
  it("passes a well-formed contract through", async () => {
    stubContractSearch([contract("CON.F.US.ENQ.U26")]);
    const [c] = await new TopstepClient().searchContracts("NQ");
    expect(c.id).toBe("CON.F.US.ENQ.U26");
    expect(c.tickSize).toBe(0.25);
  });

  it("keeps a contract whose description and symbolId are malformed", async () => {
    // Neither field has a reader in src/; a vendor quirk there must not
    // disqualify a contract the caller is asking for.
    stubContractSearch([contract("CON.F.US.ENQ.U26", { description: null, symbolId: null })]);
    const contracts = await new TopstepClient().searchContracts("NQ");
    expect(contracts.map((c) => c.id)).toEqual(["CON.F.US.ENQ.U26"]);
    expect(vi.mocked(log.event)).not.toHaveBeenCalled();
  });

  it("drops a malformed element and warns rather than throwing", async () => {
    stubContractSearch([
      contract("CON.F.US.ENQ.U26"),
      contract("CON.F.US.MNQ.U26", { tickSize: null }),
    ]);
    const contracts = await new TopstepClient().searchContracts("NQ");
    expect(contracts.map((c) => c.id)).toEqual(["CON.F.US.ENQ.U26"]);
    expect(vi.mocked(log.event)).toHaveBeenCalledWith(
      "broker_response_malformed",
      "client.searchContracts",
      expect.stringContaining("dropped 1/2 malformed contracts"),
    );
    expect(vi.mocked(log.event).mock.calls[0][2]).toContain("searchText=NQ");
    // The line used to be a `log.warn` and the warn is what the operator
    // acts on. Naming an event moved that decision to the registry, so the
    // registry is where it is pinned — otherwise the assertion above stays
    // green through a downgrade to `debug`, which prod drops outright.
    expect(eventSpec("broker_response_malformed")?.severity).toBe("warn");
  });

  it("resolves the wanted product when an unrelated element is malformed", async () => {
    stubContractSearch([
      contract("CON.F.US.NGE.U26", { description: null, tickValue: undefined }),
      contract("CON.F.US.ENQ.U26"),
    ]);
    const resolved = await new ContractResolver(new TopstepClient()).resolve("/NQ");
    expect(resolved.id).toBe("CON.F.US.ENQ.U26");
  });

  // The first MYM cell in a book (Combine, 2026-10-22). The search is fuzzy: "MYM" can return the YM mini, and only
  // the exact id root picks the micro, never the active YM ahead of it in the list.
  it("resolves /MYM to the active MYM contract past an active YM decoy and an expiring MYM", async () => {
    stubContractSearch([
      contract("CON.F.US.YM.Z26", { tickSize: 1, tickValue: 5 }),
      contract("CON.F.US.MYM.U26", { tickSize: 1, tickValue: 0.5, activeContract: false }),
      contract("CON.F.US.MYM.Z26", { tickSize: 1, tickValue: 0.5 }),
    ]);
    const resolved = await new ContractResolver(new TopstepClient()).resolve("/MYM");
    expect(resolved.id).toBe("CON.F.US.MYM.Z26");
    expect(resolved.tickValue).toBe(0.5);
  });

  it("refuses /MYM when the search returns only YM, rather than trading the mini", async () => {
    stubContractSearch([contract("CON.F.US.YM.Z26", { tickSize: 1, tickValue: 5 })]);
    await expect(new ContractResolver(new TopstepClient()).resolve("/MYM")).rejects.toThrow(
      "No active contract found for /MYM",
    );
  });

  it("surfaces an all-malformed list as a failure at the caller, naming the ticker", async () => {
    stubContractSearch([
      contract("CON.F.US.ENQ.U26", { id: null }),
      contract("CON.F.US.ENQ.Z26", { activeContract: "yes" }),
    ]);
    await expect(new ContractResolver(new TopstepClient()).resolve("/NQ")).rejects.toThrow(
      "No active contract found for /NQ",
    );
  });

  // A115: six MNQ legs reached an expired entry on one tick and sent six searches.
  it("sends one search for every leg that asks while the first is in flight", async () => {
    stubContractSearch([contract("CON.F.US.MNQ.Z26")]);
    const resolver = new ContractResolver(new TopstepClient());
    const resolved = await Promise.all(Array.from({ length: 6 }, () => resolver.resolve("/MNQ")));
    expect(resolved.map((c) => c.id)).toEqual(Array(6).fill("CON.F.US.MNQ.Z26"));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("asks again after a shared lookup failed, rather than keeping the failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" })
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ success: true, contracts: [contract("CON.F.US.MNQ.Z26")] }),
        }),
    );
    const resolver = new ContractResolver(new TopstepClient());
    const first = await Promise.allSettled([resolver.resolve("/MNQ"), resolver.resolve("/MNQ")]);
    expect(first.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((await resolver.resolve("/MNQ")).id).toBe("CON.F.US.MNQ.Z26");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

// bugs.md A88. The hook is a double here so the client's half — when it
// asks, what it does with the answer, which paths never ask — is pinned
// without auth.ts's graph. auth.test.ts drives the real pair.
describe("TopstepClient 401 handling — dead cached token", () => {
  const ACCOUNT_SEARCH = "/api/Account/search";
  const VALIDATE = "/api/Auth/validate";
  const LOGIN_KEY = "/api/Auth/loginKey";
  const ORDER_PLACE = "/api/Order/place";

  interface Call {
    path: string;
    bearer: string | null;
  }

  /** Answers 401 to every bearer except `liveToken`; `/Auth/validate`
   *  refuses a dead bearer the same way the gateway did on prod. */
  function stubGateway(liveToken: string | null): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        const path = new URL(url).pathname;
        const bearer = init.headers.Authorization?.replace("Bearer ", "") ?? null;
        calls.push({ path, bearer });
        if (bearer !== liveToken) return { ok: false, status: 401, text: async () => "" };
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, accounts: [], newToken: bearer, orderId: 7 }),
        };
      }),
    );
    return calls;
  }

  function installRecovery(remint: (dead: string, path: string) => Promise<string | null>) {
    const recovery = { remint: vi.fn(remint), discard: vi.fn() };
    topstepSessionState().recovery = recovery;
    return recovery;
  }

  function clientOn(token: string): TopstepClient {
    const client = new TopstepClient();
    client.setToken(token);
    return client;
  }

  const placeRequest: PlaceOrderRequest = {
    accountId: 1,
    contractId: "CON.F.US.MNQ.Z26",
    type: 2,
    side: 0,
    size: 1,
  };

  afterEach(() => {
    topstepSessionState().recovery = null;
  });

  /**
   * The engine's client is shared, so two calls can be in flight on the same
   * dead token. `gated` holds the second one's first response until the first
   * call has recovered and moved the client onto `tok-fresh`. Validate refuses
   * every bearer — a transient failure on the fresh one is what would
   * otherwise send the live token to the recovery as the refused one.
   */
  function stubSiblingGateway(gated: (path: string, deadSends: number) => boolean) {
    const calls: Call[] = [];
    let deadSends = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        const path = new URL(url).pathname;
        const bearer = init.headers.Authorization?.replace("Bearer ", "") ?? null;
        calls.push({ path, bearer });
        if (bearer === "tok-dead" && path !== VALIDATE) {
          deadSends++;
          if (gated(path, deadSends)) await gate;
        }
        if (path === VALIDATE || bearer !== "tok-fresh") {
          return { ok: false, status: 401, text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, accounts: [], orderId: 7 }),
        };
      }),
    );
    return { calls, release };
  }

  it("reports the token the request was sent on, not the one a sibling call has since put on the client", async () => {
    const gw = stubSiblingGateway((_path, deadSends) => deadSends === 2);
    const recovery = installRecovery(async () => "tok-fresh");
    const client = clientOn("tok-dead");

    const first = client.searchAccounts();
    const second = client.searchAccounts();
    await expect(first).resolves.toEqual([]);
    expect(client.getToken()).toBe("tok-fresh");
    gw.release();

    await expect(second).resolves.toEqual([]);
    expect(recovery.remint.mock.calls.map((c) => c[0])).toEqual(["tok-dead", "tok-dead"]);
  });

  it("hands /api/Order/place's own dead token to be dropped, not a sibling's fresh one", async () => {
    const gw = stubSiblingGateway((path) => path === ORDER_PLACE);
    const recovery = installRecovery(async () => "tok-fresh");
    const client = clientOn("tok-dead");

    const search = client.searchAccounts();
    const place = client.placeOrder(placeRequest);
    await expect(search).resolves.toEqual([]);
    expect(client.getToken()).toBe("tok-fresh");
    gw.release();

    await expect(place).rejects.toBeInstanceOf(UnauthorizedError);
    expect(recovery.discard.mock.calls).toEqual([["tok-dead", ORDER_PLACE]]);
    expect(gw.calls.filter((c) => c.path === ORDER_PLACE)).toHaveLength(1);
  });

  it("asks for a replacement when the 401 survives validate, and retries once on it", async () => {
    const calls = stubGateway("tok-fresh");
    const recovery = installRecovery(async () => "tok-fresh");
    const client = clientOn("tok-dead");

    await expect(client.searchAccounts()).resolves.toEqual([]);

    expect(recovery.remint).toHaveBeenCalledTimes(1);
    expect(recovery.remint).toHaveBeenCalledWith("tok-dead", ACCOUNT_SEARCH);
    expect(calls).toEqual([
      { path: ACCOUNT_SEARCH, bearer: "tok-dead" },
      { path: VALIDATE, bearer: "tok-dead" },
      { path: ACCOUNT_SEARCH, bearer: "tok-fresh" },
    ]);
    // What the engine's heartbeat compares against the hubs' session token.
    expect(client.getToken()).toBe("tok-fresh");
  });

  it("does not ask twice when the replacement is refused too", async () => {
    const calls = stubGateway(null);
    const recovery = installRecovery(async () => "tok-also-dead");

    await expect(clientOn("tok-dead").searchAccounts()).rejects.toBeInstanceOf(UnauthorizedError);

    expect(recovery.remint).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === ACCOUNT_SEARCH)).toHaveLength(2);
  });

  it("does not ask when validate revives the session", async () => {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        const path = new URL(url).pathname;
        const bearer = init.headers.Authorization?.replace("Bearer ", "") ?? null;
        calls.push({ path, bearer });
        if (path === ACCOUNT_SEARCH && bearer === "tok-stale") {
          return { ok: false, status: 401, text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, accounts: [], newToken: "tok-rolled" }),
        };
      }),
    );
    const recovery = installRecovery(async () => "unused");

    await expect(clientOn("tok-stale").searchAccounts()).resolves.toEqual([]);

    expect(recovery.remint).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ path: ACCOUNT_SEARCH, bearer: "tok-rolled" });
  });

  it("rethrows the original 401 when the recovery declines", async () => {
    stubGateway(null);
    installRecovery(async () => null);
    await expect(clientOn("tok-dead").searchAccounts()).rejects.toThrow(
      `Unauthorized on ${ACCOUNT_SEARCH}`,
    );
  });

  it("rethrows the original 401 when the recovery itself fails", async () => {
    stubGateway(null);
    installRecovery(async () => {
      throw new Error("loginKey refused");
    });
    await expect(clientOn("tok-dead").searchAccounts()).rejects.toThrow(
      `Unauthorized on ${ACCOUNT_SEARCH}`,
    );
  });

  it("never retries or re-mints on /api/Order/place, and hands the dead token over to be dropped", async () => {
    const calls = stubGateway("tok-fresh");
    const recovery = installRecovery(async () => "tok-fresh");

    await expect(clientOn("tok-dead").placeOrder(placeRequest)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // One request, total: a second place could duplicate a live order.
    expect(calls).toEqual([{ path: ORDER_PLACE, bearer: "tok-dead" }]);
    expect(recovery.remint).not.toHaveBeenCalled();
    expect(recovery.discard).toHaveBeenCalledTimes(1);
    expect(recovery.discard).toHaveBeenCalledWith("tok-dead", ORDER_PLACE);
  });

  it("never recurses from /api/Auth/validate", async () => {
    const calls = stubGateway(null);
    const recovery = installRecovery(async () => "tok-fresh");

    await expect(clientOn("tok-dead").validateSession()).rejects.toBeInstanceOf(UnauthorizedError);

    expect(calls).toEqual([{ path: VALIDATE, bearer: "tok-dead" }]);
    expect(recovery.remint).not.toHaveBeenCalled();
    expect(recovery.discard).not.toHaveBeenCalled();
  });

  it("never recurses from /api/Auth/loginKey", async () => {
    const calls = stubGateway(null);
    const recovery = installRecovery(async () => "tok-fresh");

    await expect(
      clientOn("tok-dead").authenticate({ userName: "u", apiKey: "k" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(calls).toEqual([{ path: LOGIN_KEY, bearer: "tok-dead" }]);
    expect(recovery.remint).not.toHaveBeenCalled();
    expect(recovery.discard).not.toHaveBeenCalled();
  });
});

describe("TopstepClient — request counting", () => {
  afterEach(() => {
    takeTopstepRequestWindow();
  });

  it("counts every attempt it sends and each 429 it gets back", async () => {
    takeTopstepRequestWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }),
    );
    const client = new TopstepClient();
    client.setToken("tok");

    await expect(client.searchOpenPositions(1)).rejects.toThrow(/429/);
    await expect(client.searchOpenPositions(1)).rejects.toThrow(/429/);

    expect(takeTopstepRequestWindow()).toBe("rest 2/win, 2 refused (Position/searchOpen 2 ×2)");
  });
});

// The engine's re-snapshot queue defers a rate-limited read by reading
// `status` off the thrown error (`isRateLimitRefusal`), never the message.
describe("TopstepClient — a non-2xx answer carries its status", () => {
  async function refusalFor(status: number): Promise<unknown> {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status, text: async () => "" }),
    );
    const client = new TopstepClient();
    client.setToken("tok");
    return client.searchOpenPositions(1).then(
      () => { throw new Error("expected a refusal"); },
      (err: unknown) => err,
    );
  }

  it("a 429 throws an error whose status is 429", async () => {
    const err = await refusalFor(429);
    expect(err).toBeInstanceOf(TopstepHttpError);
    expect((err as TopstepHttpError).status).toBe(429);
  });

  it("a 500 throws an error whose status is 500", async () => {
    const err = await refusalFor(500);
    expect((err as TopstepHttpError).status).toBe(500);
  });

  it("keeps the message every message-reading catch matches on", async () => {
    const err = await refusalFor(429);
    expect((err as Error).message).toBe(
      'Topstep API error 429 on /api/Position/searchOpen: (empty body) | payload={"accountId":1}',
    );
  });
});

// A89. /Order/searchOpen carries ProjectX's wire OrderStatus (Expired 4,
// Rejected 5, Pending 6), so the REST path has to map it exactly as the hub
// does, or the watchdog's one snapshot per position reads the old meanings.
describe("TopstepClient.searchOpenOrders — wire status mapping", () => {
  function wireOrder(id: number, status: number): Record<string, unknown> {
    return {
      id,
      accountId: 7,
      contractId: "CON.F.US.MNQ.Z26",
      creationTimestamp: "2026-10-23T14:00:00Z",
      updateTimestamp: "2026-10-23T14:00:01Z",
      status,
      type: 4,
      side: 1,
      size: 1,
      limitPrice: null,
      stopPrice: 24650,
      filledPrice: null,
    };
  }

  function stubOpenOrders(orders: unknown[]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, errorCode: 0, errorMessage: null, orders }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("maps every documented wire status to the neutral one", async () => {
    stubOpenOrders([1, 2, 3, 4, 5, 6].map((s) => wireOrder(s, s)));
    const client = new TopstepClient();
    client.setToken("tok");
    const orders = await client.searchOpenOrders(7);
    expect(orders.map((o) => [o.id, o.status])).toEqual([
      [1, 1], [2, 2], [3, 3], [4, 3], [5, 4], [6, 5],
    ]);
    expect(log.event).not.toHaveBeenCalled();
  });

  it("serves the mapped list from its cache, not the wire one", async () => {
    const fetchMock = stubOpenOrders([wireOrder(5, 5), wireOrder(6, 6)]);
    const client = new TopstepClient();
    client.setToken("tok");
    await client.searchOpenOrders(7);
    const cached = await client.searchOpenOrders(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.map((o) => o.status)).toEqual([4, 5]);
  });

  it("passes the undocumented status 8 through and warns", async () => {
    stubOpenOrders([wireOrder(8, 8)]);
    const client = new TopstepClient();
    client.setToken("tok");
    const [order] = await client.searchOpenOrders(7);
    expect(order.status).toBe(8);
    expect(log.event).toHaveBeenCalledWith(
      "broker_code_unknown",
      "topstep",
      expect.stringContaining("unknown status=8"),
    );
  });

  // Same codes, same checks as the hub's `toOrder`: an unidentified type or
  // side on the REST path warns too, and still flows through.
  it.each([
    ["type", { type: 9 }],
    ["side", { side: 2 }],
  ])("warns on an unidentified %s and passes it through", async (field, over) => {
    stubOpenOrders([{ ...wireOrder(1, 1), ...over }]);
    const client = new TopstepClient();
    client.setToken("tok");
    const [order] = await client.searchOpenOrders(7);
    expect(order).toMatchObject(over);
    expect(log.event).toHaveBeenCalledWith(
      "broker_code_unknown",
      "topstep",
      expect.stringContaining(`unknown ${field}=${Object.values(over)[0]}`),
    );
  });

  // The browser reducer and the account view keep status 1 only; the
  // mapping leaves 1 as 1, so the working set is exactly the wire Open set.
  it("leaves the working set (status 1) exactly the wire Open orders", async () => {
    stubOpenOrders([1, 4, 5, 6].map((s) => wireOrder(s, s)));
    const client = new TopstepClient();
    client.setToken("tok");
    const orders = await client.searchOpenOrders(7);
    expect(orders.filter((o) => o.status === 1).map((o) => o.id)).toEqual([1]);
  });
});

// A21. An exit storm stacked one /Order/searchOpen per forceFresh caller.
describe("TopstepClient.searchOpenOrders — single flight", () => {
  const ORDER_SEARCH = "/api/Order/searchOpen";
  const ORDER_PLACE = "/api/Order/place";

  /** Holds every searchOpen answer until `release()`; place answers at once. */
  function gatedGateway(): { searches: () => number; release: () => void } {
    let releaseAll: () => void = () => {};
    let gate = new Promise<void>((r) => { releaseAll = r; });
    let searches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(ORDER_PLACE)) {
          return { ok: true, status: 200, json: async () => ({ success: true, orderId: 9, errorCode: 0, errorMessage: null }) };
        }
        if (!url.endsWith(ORDER_SEARCH)) throw new Error(`unexpected ${url}`);
        const n = ++searches;
        await gate;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            errorCode: 0,
            errorMessage: null,
            orders: [{
              id: n, accountId: 7, contractId: "CON.F.US.MNQ.Z26",
              creationTimestamp: "2026-10-23T14:00:00Z", updateTimestamp: "2026-10-23T14:00:01Z",
              status: 1, type: 4, side: 1, size: 1, limitPrice: null, stopPrice: 24650, filledPrice: null,
            }],
          }),
        };
      }),
    );
    return {
      searches: () => searches,
      release: () => {
        releaseAll();
        gate = new Promise<void>((r) => { releaseAll = r; });
      },
    };
  }

  function client(): TopstepClient {
    const c = new TopstepClient();
    c.setToken("tok");
    return c;
  }

  it("shares one request among concurrent forceFresh callers, and every caller gets its answer", async () => {
    const gw = gatedGateway();
    const c = client();
    const reads = [1, 2, 3].map(() => c.searchOpenOrders(7, { forceFresh: true }));
    gw.release();
    const answers = await Promise.all(reads);
    expect(gw.searches()).toBe(1);
    expect(answers.map((a) => a.map((o) => o.id))).toEqual([[1], [1], [1]]);
  });

  it("issues a new request for a forceFresh call after the shared one settled", async () => {
    const gw = gatedGateway();
    const c = client();
    const first = Promise.all([1, 2, 3].map(() => c.searchOpenOrders(7, { forceFresh: true })));
    gw.release();
    await first;

    const fourth = c.searchOpenOrders(7, { forceFresh: true });
    gw.release();
    expect((await fourth).map((o) => o.id)).toEqual([2]);
    expect(gw.searches()).toBe(2);
  });

  it("does not share across accounts", async () => {
    const gw = gatedGateway();
    const c = client();
    const reads = [c.searchOpenOrders(7, { forceFresh: true }), c.searchOpenOrders(8, { forceFresh: true })];
    gw.release();
    await Promise.all(reads);
    expect(gw.searches()).toBe(2);
  });

  it("shares a rejection with every caller and asks again afterwards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 429, text: async () => "" }),
    );
    const c = client();
    const reads = [1, 2].map(() => c.searchOpenOrders(7, { forceFresh: true }));
    await expect(reads[0]).rejects.toThrow(/429/);
    await expect(reads[1]).rejects.toThrow(/429/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    stubOpenOrdersOnce();
    await expect(c.searchOpenOrders(7, { forceFresh: true })).resolves.toEqual([]);
  });

  // The exit sweep and the bracket attribution decide what to cancel off this
  // read, so a caller arriving after our own order went in must never be
  // handed a read that left before it — nor may that read refill the cache.
  it("does not hand a read that left before our own place to a caller arriving after it", async () => {
    const gw = gatedGateway();
    const c = client();
    const before = c.searchOpenOrders(7, { forceFresh: true });
    await c.placeOrder({ accountId: 7, contractId: "CON.F.US.MNQ.Z26", type: 2, side: 0, size: 1 });
    const after = c.searchOpenOrders(7, { forceFresh: true });
    gw.release();

    expect((await before).map((o) => o.id)).toEqual([1]);
    expect((await after).map((o) => o.id)).toEqual([2]);
    expect(gw.searches()).toBe(2);
    // The cache holds the post-place read, not the one the place overtook.
    expect((await c.searchOpenOrders(7)).map((o) => o.id)).toEqual([2]);
    expect(gw.searches()).toBe(2);
  });

  // The ordering above settles the stale read first, so the fresh read
  // overwrites it either way. Here the stale read settles last: only the
  // `=== read` guard stops it refilling the cache over the post-place answer.
  it("a read that left before our own place and settles last does not refill the cache", async () => {
    const releases: Array<() => void> = [];
    let searches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(ORDER_PLACE)) {
          return { ok: true, status: 200, json: async () => ({ success: true, orderId: 9, errorCode: 0, errorMessage: null }) };
        }
        if (!url.endsWith(ORDER_SEARCH)) throw new Error(`unexpected ${url}`);
        const n = ++searches;
        await new Promise<void>((r) => releases.push(r));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            errorCode: 0,
            errorMessage: null,
            orders: [{
              id: n, accountId: 7, contractId: "CON.F.US.MNQ.Z26",
              creationTimestamp: "2026-10-23T14:00:00Z", updateTimestamp: "2026-10-23T14:00:01Z",
              status: 1, type: 4, side: 1, size: 1, limitPrice: null, stopPrice: 24650, filledPrice: null,
            }],
          }),
        };
      }),
    );
    const c = client();
    const before = c.searchOpenOrders(7, { forceFresh: true });
    await c.placeOrder({ accountId: 7, contractId: "CON.F.US.MNQ.Z26", type: 2, side: 0, size: 1 });
    const after = c.searchOpenOrders(7, { forceFresh: true });
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[1]();
    expect((await after).map((o) => o.id)).toEqual([2]);
    releases[0]();
    expect((await before).map((o) => o.id)).toEqual([1]);

    expect((await c.searchOpenOrders(7)).map((o) => o.id)).toEqual([2]);
    expect(searches).toBe(2);
  });

  // The `=== read` guard on the in-flight delete: a stale read settling first
  // must not evict the post-place read still in flight, or a caller after it
  // sends a request of its own instead of joining.
  it("a read that left before our own place and settles first leaves the post-place read shared", async () => {
    const releases: Array<() => void> = [];
    let searches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(ORDER_PLACE)) {
          return { ok: true, status: 200, json: async () => ({ success: true, orderId: 9, errorCode: 0, errorMessage: null }) };
        }
        if (!url.endsWith(ORDER_SEARCH)) throw new Error(`unexpected ${url}`);
        const n = ++searches;
        await new Promise<void>((r) => releases.push(r));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, errorCode: 0, errorMessage: null, orders: [{ id: n, accountId: 7 }] }),
        };
      }),
    );
    const c = client();
    const before = c.searchOpenOrders(7, { forceFresh: true });
    await c.placeOrder({ accountId: 7, contractId: "CON.F.US.MNQ.Z26", type: 2, side: 0, size: 1 });
    const after = c.searchOpenOrders(7, { forceFresh: true });
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[0]();
    expect((await before).map((o) => o.id)).toEqual([1]);
    const third = c.searchOpenOrders(7, { forceFresh: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(searches).toBe(2);

    releases[1]();
    expect((await after).map((o) => o.id)).toEqual([2]);
    expect((await third).map((o) => o.id)).toEqual([2]);
  });

  // A place, cancel or modify that throws may still have reached the gateway
  // — the order placed, the answer lost — so the invalidation runs on every
  // outcome, not only once the await succeeds.
  type Mutation = "place" | "placeRaw" | "cancel" | "modify";
  const MUTATION_PATH: Record<Mutation, string> = {
    place: ORDER_PLACE,
    placeRaw: ORDER_PLACE,
    cancel: "/api/Order/cancel",
    modify: "/api/Order/modify",
  };
  const PLACE_REQUEST = { accountId: 7, contractId: "CON.F.US.MNQ.Z26", type: 2, side: 0, size: 1 } as const;
  const mutate: Record<Mutation, (c: TopstepClient) => Promise<unknown>> = {
    place: (c) => c.placeOrder(PLACE_REQUEST),
    placeRaw: (c) => c.placeOrderRaw(PLACE_REQUEST),
    cancel: (c) => c.cancelOrder(9, 7),
    modify: (c) => c.modifyOrder(7, 9, { stopPrice: 24640 }),
  };

  type Outcome = "throws" | "refuses" | "succeeds";

  /** searchOpen answers at once with a one-order book whose id counts the
   *  requests; the mutation's own request rejects (`throws`), answers
   *  `success: false` (`refuses`) or succeeds. */
  function mutationGateway(m: Mutation, outcome: Outcome): { searches: () => number; mutations: () => number } {
    let searches = 0;
    let mutations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(MUTATION_PATH[m])) {
          mutations++;
          if (outcome === "throws") throw new Error("socket hang up");
          const success = outcome === "succeeds";
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success,
              orderId: success ? 9 : 0,
              errorCode: success ? 0 : 2,
              errorMessage: success ? null : "refused",
            }),
          };
        }
        if (!url.endsWith(ORDER_SEARCH)) throw new Error(`unexpected ${url}`);
        const n = ++searches;
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, errorCode: 0, errorMessage: null, orders: [{ id: n, accountId: 7 }] }),
        };
      }),
    );
    return { searches: () => searches, mutations: () => mutations };
  }

  // Date frozen: with the wall clock running, the 1 s TTL could lapse
  // mid-case and a row would pass on expiry with the invalidation removed.
  describe("the cached book under a mutation, Date frozen", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([
      ["place", "throws"], ["placeRaw", "throws"], ["cancel", "throws"], ["modify", "throws"],
      ["place", "refuses"], ["cancel", "refuses"],
      ["place", "succeeds"], ["cancel", "succeeds"], ["modify", "succeeds"],
    ] as const)("a %s that %s drops the cached book, so the next read goes to the gateway", async (m, outcome) => {
      const gw = mutationGateway(m, outcome);
      const c = client();
      await c.searchOpenOrders(7);
      expect((await c.searchOpenOrders(7)).map((o) => o.id)).toEqual([1]);
      expect(gw.searches()).toBe(1);

      const settled = mutate[m](c);
      if (outcome === "throws") await expect(settled).rejects.toThrow(/socket hang up/);
      else if (outcome === "refuses") await expect(settled).rejects.toThrow(/refused/);
      else await settled;

      expect((await c.searchOpenOrders(7)).map((o) => o.id)).toEqual([2]);
      expect(gw.searches()).toBe(2);
    });

    // Nothing reached the gateway, so the book is provably unchanged.
    it("a place refused for an over-cap customTag sends nothing and keeps the cached book", async () => {
      const gw = mutationGateway("place", "succeeds");
      const c = client();
      await c.searchOpenOrders(7);

      await expect(c.placeOrder({ ...PLACE_REQUEST, customTag: "x".repeat(61) })).rejects.toThrow(/customTag exceeds/);
      expect(gw.mutations()).toBe(0);

      expect((await c.searchOpenOrders(7)).map((o) => o.id)).toEqual([1]);
      expect(gw.searches()).toBe(1);
    });
  });

  it.each(["place", "cancel", "modify"] as const)(
    "a %s that throws drops the in-flight read: a caller after it gets its own, and the stale one does not refill the cache",
    async (m) => {
      const releases: Array<() => void> = [];
      let searches = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith(MUTATION_PATH[m])) throw new Error("socket hang up");
          if (!url.endsWith(ORDER_SEARCH)) throw new Error(`unexpected ${url}`);
          const n = ++searches;
          await new Promise<void>((r) => releases.push(r));
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, errorCode: 0, errorMessage: null, orders: [{ id: n, accountId: 7 }] }),
          };
        }),
      );
      const c = client();
      const before = c.searchOpenOrders(7, { forceFresh: true });
      await expect(mutate[m](c)).rejects.toThrow(/socket hang up/);
      const after = c.searchOpenOrders(7, { forceFresh: true });
      await vi.waitFor(() => expect(releases).toHaveLength(2));

      releases[1]();
      expect((await after).map((o) => o.id)).toEqual([2]);
      releases[0]();
      expect((await before).map((o) => o.id)).toEqual([1]);

      expect((await c.searchOpenOrders(7)).map((o) => o.id)).toEqual([2]);
      expect(searches).toBe(2);
    },
  );

  function stubOpenOrdersOnce(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, errorCode: 0, errorMessage: null, orders: [] }),
      }),
    );
  }
});

// A120. Every `success: false` place answer but AccountNotFound used to be a
// plain Error, so the rejection-triggered status check could not tell a
// risk-rule refusal from a transport failure. Codes are ProjectX's
// PlaceOrderErrorCode enum (gateway.docs.projectx.com, Order/place).
describe("TopstepClient.placeOrder — refusals", () => {
  const placeRequest: PlaceOrderRequest = {
    accountId: 42,
    contractId: "CON.F.US.MNQ.Z26",
    type: 2,
    side: 0,
    size: 1,
  };

  function stubPlaceAnswer(errorCode: number, errorMessage: string | null): void {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: false, orderId: 0, errorCode, errorMessage }),
      }),
    );
  }

  async function placeError(errorCode: number, errorMessage: string | null): Promise<unknown> {
    stubPlaceAnswer(errorCode, errorMessage);
    const client = new TopstepClient();
    client.setToken("tok");
    return client.placeOrder(placeRequest).then(
      () => { throw new Error("placeOrder resolved"); },
      (err: unknown) => err,
    );
  }

  // The DLL lock has no code of its own in the enum; which of these risk-rule
  // codes it arrives on is unobserved, so each must carry through typed.
  it.each([
    [2, "OrderRejected"],
    [3, "InsufficientFunds"],
    [4, "AccountViolation"],
    [10, "AccountRejected"],
  ])("throws a typed rejection carrying risk-rule code %i (%s)", async (code, name) => {
    const err = await placeError(code, "Daily loss limit reached");
    expect(err).toBeInstanceOf(TopstepOrderRejectionError);
    const rejection = err as TopstepOrderRejectionError;
    expect(rejection.errorCode).toBe(code);
    expect(rejection.codeName).toBe(name);
    expect(rejection.accountId).toBe(42);
    // The gateway's own text leads the message the entry-rejected and
    // watchdog lines print, and the code and its name trail it, so a live
    // refusal shows which code a Daily Loss Limit arrives on (topstep.md).
    expect(rejection.message).toBe(`Daily loss limit reached (errorCode ${code} ${name})`);
  });

  it.each([
    [5, "OutsideTradingHours"],
    [8, "ContractNotFound"],
    [9, "ContractNotActive"],
  ])("types the market and contract refusal code %i too", async (code, name) => {
    const err = await placeError(code, null);
    expect(err).toBeInstanceOf(TopstepOrderRejectionError);
    expect((err as Error).message).toBe(`Failed to place order (errorCode ${code} ${name})`);
  });

  // Pending says the order may yet exist and UnknownError says nothing; an
  // undocumented code is neither a refusal we can name. Plain, so unowned.
  it.each([6, 7, 0, 99])("keeps code %i a plain Error", async (code) => {
    const err = await placeError(code, "something");
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TopstepOrderRejectionError);
    expect(err).not.toBeInstanceOf(AccountNotFoundError);
  });

  it("keeps AccountNotFound its own type", async () => {
    const err = await placeError(1, "Account not found");
    expect(err).toBeInstanceOf(AccountNotFoundError);
    expect(err).not.toBeInstanceOf(TopstepOrderRejectionError);
    expect((err as AccountNotFoundError).accountId).toBe(42);
  });
});

// Watchlist (auth `log.debug` builds stack traces eagerly): the message is
// built before the `DEBUG_TAGS` gate runs, so a stack walk inside it ran on
// every login and validate even with the tag off — and prod never keeps a
// debug line at all. Scanned from source, the way patterns.md guards a call
// site that must not come back.
describe("TopstepClient — auth debug lines", () => {
  it("watchlist: no line builds a stack trace", () => {
    const source = readFileSync(join(__dirname, "client.ts"), "utf8");
    expect(source).toContain("log.debug(");
    expect(source).not.toMatch(/new Error\(\)\.stack/);
  });
});
