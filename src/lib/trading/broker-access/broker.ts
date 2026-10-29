import type {
  Account,
  Contract,
  Order,
  Position,
  TradeFill,
  PlaceOrderRequest,
  PlaceOrderResponse,
} from "@/lib/brokers/types";

/**
 * Broker — the broker-neutral surface the engine uses to interact with any
 * supported execution venue. Topstep and Tradovate both implement it and
 * translate to/from these neutral shapes at their own boundaries.
 *
 * Methods deliberately NOT in this interface — callers reach them through a
 * concrete client reference:
 *   - authenticate, validateSession, setToken, getToken — auth lifecycles
 *     diverge per broker and the Topstep token specifically pumps into the
 *     SignalR hubs. A unified auth interface would force no-op stubs on
 *     both sides.
 *   - getContractById — still called on a raw `TopstepClient` by
 *     `/api/contracts/by-id`, and deliberately left off. That route already
 *     routes by id shape, and its Tradovate arm wants tick parameters
 *     (`getContractSpec`) rather than a `Contract`: Tradovate can populate
 *     neither `id` (the bars / market-data key, which it has no entitlement
 *     to produce) nor `symbolId` nor `description`. Putting it here would
 *     grow a member whose only honest Tradovate implementation is a throw
 *     and whose one caller does not want the return shape.
 *   - retrieveBars — not a broker concern at all any more. Every bar read
 *     goes through `marketDataRegistry`; the client method survives only
 *     because `TopstepMarketDataProvider` wraps it.
 *   - placeOrderRaw — dev/test probe; Topstep-only.
 */
export interface Broker {
  searchAccounts(onlyActive?: boolean): Promise<Account[]>;

  searchOpenOrders(
    accountId: number,
    opts?: { forceFresh?: boolean },
  ): Promise<Order[]>;
  searchOpenPositions(accountId: number): Promise<Position[]>;
  searchTrades(
    accountId: number,
    startTimestamp: string,
    endTimestamp?: string,
  ): Promise<TradeFill[]>;

  /**
   * Historical fill lookup scoped to a single order id. Required for
   * post-restart reconciliation on brokers whose session-fill list
   * (`searchTrades`) only returns the current session — Tradovate's
   * `/fill/list` behaves this way, while `/fill/deps?masterid=…` does
   * not. Topstep's `/Trade/search` is already historical, so the
   * Topstep client returns `[]` and the engine continues to rely on
   * `searchTrades` there.
   */
  getFillsForOrder(orderId: number, accountId: number): Promise<TradeFill[]>;

  /**
   * Fuzzy contract discovery. `/api/contracts`, `/api/dev/contract-search`
   * and the three backtest routes reach it here instead of constructing
   * their own client.
   *
   * **Tradovate throws.** Its `/contract/suggest` carries no tick size,
   * no description and no `symbolId`, and its numeric id is an execution
   * identifier, not the market-data key `Contract.id` means — see
   * `TradovateClient.searchContracts` for the full reasoning. A caller
   * with no account in scope is asking a Topstep-shaped question and
   * gets a loud failure rather than a `Contract` whose `tickSize` was
   * invented.
   *
   * `live` selects which **market-data subscription** the search runs
   * against — Topstep's `/api/Contract/search` takes `{ searchText, live }`
   * and answers out of the live-CME set or the simulated one. It is the
   * same sim/live axis as `RetrieveBarsRequest.live`, and it has nothing
   * to do with whether the *account* is live: that is
   * `autoTradeVerdict`'s question and it has exactly one implementation.
   * Nor is it `TradingState.live`, which means a realtime adapter is
   * streaming. Defaults to `false`, which is what every caller but
   * `/api/dev/contract-search` passes — that route exposes it so an
   * operator can diff the two sets by hand.
   *
   * **A broker whose contract universe has no sim/live split ignores the
   * argument** and answers from its single set. It does not throw on
   * `true`, and it does not reinterpret it as an account flag.
   */
  searchContracts(searchText: string, live?: boolean): Promise<Contract[]>;

  placeOrder(order: PlaceOrderRequest): Promise<PlaceOrderResponse>;
  cancelOrder(orderId: number, accountId: number): Promise<void>;
  modifyOrder(
    accountId: number,
    orderId: number,
    updates: {
      size?: number;
      limitPrice?: number;
      stopPrice?: number;
      trailPrice?: number;
    },
  ): Promise<void>;

  invalidateOpenOrders(accountId: number): void;
}
