// Naked-position safety watchdog extracted from engine.ts: the periodic
// account-scoped sweep, the two-strike memory it runs on, the SL-coverage
// lookups for both coverage sources, and the last-resort flatten with the
// bracket cleanup that follows it.
//
// Like engine-market-hub.ts and unlike the `*Deps` pure-function satellites,
// this is a stateful controller: the two-strike set and the post-flatten
// cooldown map are written from inside the sweep and read nowhere else, so
// the fields moved here rather than staying on the engine behind getters.
// The engine holds one instance and drives it from its own interval. The
// `*Deps` interface is still how the module reaches back into the engine, so
// no private engine method was made public to accommodate it.
//
// `flattenNakedPosition` reaches `deps.brokerForAccount().placeOrder`
// directly instead of going through `placeExitOrder`. That bypass of the
// per-deployment exit latch is deliberate and load-bearing — this is the
// last-resort path for a position the normal exit machinery has already
// failed to protect, so it must not be refusable by that machinery's own
// guard. See engine.md's "One exit at a time per deployment" hard rule,
// which names this alongside flatten-all. Do not route it through the latch.
//
// The bypass is why the post-flatten cooldown is **not** one of the fields
// this controller owns. Bypassing the latch means the only thing standing
// between this sweep and D-2 enforcement — the other actor that submits a
// market order against a position it has not re-read — is that cooldown, and
// a cooldown two actors cannot both see stops nothing. It lives in
// `engine-flatten-cooldown.ts` and arrives through `NakedWatchdogDeps`.

import type { Broker } from "../../broker-access/broker";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { BrokerCapabilities, BrokerErrorKind } from "@/lib/brokers/plugin";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import { TRADOVATE_CANCELABLE_STATUSES } from "@/lib/brokers/tradovate/fill-mapping";
import type {
  Contract,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  PlaceOrderRequest,
  Position,
} from "@/lib/brokers/types";
import { POSITION_TYPE_LONG } from "@/lib/brokers/types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import { FLATTEN_COOLDOWN_MS, type FlattenCooldown } from "../engine-flatten-cooldown";
import { ENTRY_REFUSAL_KINDS } from "../engine-account-status";
import { LIVE_ORDER_STATUSES, isLiveProtectiveLeg } from "../engine-exit-legs";
import { executionContractId } from "../../broker-access/contract-resolver";
import { getReconcilableTrades, listAccountsWithReconcilableTrades } from "@/lib/db/trades";
import { recordOrders, recordPositions } from "../realtime/account-view";
import {
  findActiveOrderMappingsByAccount,
  markTerminal as markTradovateOrderTerminal,
} from "@/lib/db/tradovate-order-map";
import type { LogSubject } from "../engine";
import { ENGINE_SCOPE, type LogCategory, type Severity } from "@/lib/logging/vocabulary";
import { trackOrderRequest } from "@/lib/shutdown-drain";
import { leaseGate } from "@/lib/db/lease";

/**
 * Naked-position safety watchdog. Every interval, sweep open positions for
 * every account the engine touches and verify each has at least one live
 * Stop Market order on the closing side that covers the full size. A
 * position observed naked across two consecutive watchdog ticks is flattened
 * with reason `safety_no_bracket`.
 *
 * Two-strike rule: filters the legitimate gap between an entry market fill
 * landing and the bracket attach posting (`reconcileBracketsForTrade` runs
 * on the REST tick or via the user-hub fast path). The effective tolerance
 * is `2 × interval` (one tick to log the first observation, second tick to
 * flatten), so 30s here means up to ~60s of real-world tolerance — bounds
 * naked exposure to under a minute. If you tune the interval, remember the
 * doubling: a 15s interval gives ~30s of tolerance, not 15s.
 */
export const NAKED_POSITION_WATCHDOG_INTERVAL_MS = 30_000;

/**
 * When a failed flatten is retried, by what the failure proves (A37).
 *
 * A refusal — the broker answered and said no — proves no order is on the
 * book, so the stamp is released and the strike kept: the next tick flattens.
 * Anything else (a timeout, a dropped connection, an error no plugin claims)
 * may be an order the broker accepted and we never heard back about, and a
 * second market order on top of it is the double flatten the cooldown exists
 * to prevent. That case keeps the stamp and clears the strike, so the retry
 * waits out the cooldown and then needs two fresh strikes.
 */
const MS_PER_S = 1000;
const REFUSED_FLATTEN_RETRY_WINDOW = `${NAKED_POSITION_WATCHDOG_INTERVAL_MS / MS_PER_S}s`;
const UNCONFIRMED_FLATTEN_RETRY_WINDOW =
  `${(FLATTEN_COOLDOWN_MS + NAKED_POSITION_WATCHDOG_INTERVAL_MS) / MS_PER_S}–` +
  `${(FLATTEN_COOLDOWN_MS + 2 * NAKED_POSITION_WATCHDOG_INTERVAL_MS) / MS_PER_S}s`;

/** What `flattenNakedPosition` learned from the submit. */
type FlattenOutcome =
  | { kind: "accepted"; orderId: number }
  | { kind: "refused" }
  | { kind: "unconfirmed" };

const ORDER_SIDE_BUY: OrderSide = 0;
const ORDER_SIDE_SELL: OrderSide = 1;
const ORDER_TYPE_MARKET: OrderType = 2;
/**
 * Only Stop Market counts as coverage. Stop Limit (type 3) is intentionally
 * excluded: engine-managed brackets are always Stop Market, and the
 * managed-contract scope filter guarantees we only inspect contracts the
 * engine owns. If that scope is ever loosened to cover user-placed orders,
 * count Stop Limit here too.
 */
const ORDER_TYPE_STOP_MARKET: OrderType = 4;
/** How many consecutive passes a stop in a transitional status still counts
 *  as coverage — the two-strike rule's span: a Tradovate stop reporting
 *  `Unknown` on the order-map arm, and a Pending stop on the open-orders arm
 *  (Topstep's wire Pending, A89). Transient, either is live; one that stays
 *  (lost or never promoted at the gateway) must not hold a naked position
 *  open forever. */
const MAX_UNKNOWN_COVERAGE_PASSES = 2;
const TRADOVATE_UNKNOWN_STATUS = "Unknown";
const ORDER_STATUS_PENDING: OrderStatus = 5;

/** Order id → consecutive passes it has read in one transitional status. An
 *  id not read that way in a pass is dropped at the end of it. */
interface TransitionalStopRun {
  passes: Map<number, number>;
  seenThisPass: Set<number>;
}

function newTransitionalStopRun(): TransitionalStopRun {
  return { passes: new Map(), seenThisPass: new Set() };
}

/**
 * Engine-internal surface the naked-position watchdog calls back into.
 * Mirrors the `MarketHubDeps` / `ExitOrderDeps` pattern: bound callbacks
 * rather than flipped access modifiers.
 */
export interface NakedWatchdogDeps {
  log(
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ): void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category. See `TradingEngine.logEvent`. */
  logEvent(event: string, deploymentId: string, message: string, subject?: LogSubject): void;
  /** Current realtime deployment set, read at call time — the sweep must
   *  see deployments added or removed since the interval was armed. */
  realtimeDeployments(): Deployment[];
  /** Exit-eval scope predicate: engine-enabled OR holding an open position. */
  isLegInExitLoop(deployment: Deployment): boolean;
  isAccountRegistered(accountId: number): boolean;
  /** The one capability the sweep reads. Narrowed to the flag rather than
   *  the plugin that carries it, so this module has no handle on a
   *  `BrokerPlugin` it never otherwise touches. */
  stopCoverageSourceFor(accountId: number): BrokerCapabilities["stopCoverageSource"];
  brokerForAccount(accountId: number): Broker;
  defaultTradovateClient(): TradovateClient | null;
  resolveContract(ticker: TickerSymbol, accountId: number): Promise<Contract>;
  maybeOrphanFromBrokerError(err: unknown, accountId: number): void;
  /** Does the broker that raised this cancel rejection consider the order
   *  already terminal? Routed through the plugin seam beside
   *  `maybeOrphanFromBrokerError` — the engine may not value-import a broker
   *  error class to answer it. A broker that declares nothing answers false,
   *  which is the loud arm. */
  rejectionProvesTerminal(err: unknown): boolean;
  /** The owning plugin's `classifyError`, or null when no plugin claims the
   *  error. Same seam as the two above; it decides whether a failed flatten
   *  was a refusal (A37). */
  brokerErrorKind(err: unknown): BrokerErrorKind | null;
  buildCustomTag(prefix: "e" | "x" | "s", deploymentId: string): string;
  /** Post-flatten cooldown, shared with D-2 enforcement. The one piece of
   *  state this sweep uses and does not own — see the module header. */
  flattenCooldown: FlattenCooldown;
}

export class NakedPositionWatchdog {
  /** Two-strike memory. Key: `${accountId}:${contractId}:${positionType}`.
   *  Presence means the previous watchdog tick observed the position naked;
   *  on the next tick we flatten if it's still naked. Deleted whenever a
   *  position has a live SL or no longer exists. */
  private nakedPositionObservations = new Set<string>();

  /** Tradovate stops read `Unknown` (order-map arm). */
  private unknownStops = newTransitionalStopRun();
  /** Stops read Pending on the book (open-orders arm). */
  private pendingStops = newTransitionalStopRun();

  private readonly mayFlatten = leaseGate(
    "the naked-position watchdog",
    "Its flatten is left to the process that holds the lease.",
  );

  constructor(private readonly deps: NakedWatchdogDeps) {}

  /** Drop the two-strike memory. Not called on `stop()` — see engine.md —
   *  and deliberately does not touch `deps.flattenCooldown`, which this
   *  sweep does not own and which D-2 enforcement may have stamped. */
  reset(): void {
    this.nakedPositionObservations.clear();
  }

  /** Overlapping callers join this rather than sweeping again: two passes
   *  over one two-strike memory both read the strike as banked. Memoised as
   *  a promise, not a flag, per engine.md's single-flight rule. */
  private sweepInFlight: Promise<void> | null = null;

  runNakedPositionWatchdog(): Promise<void> {
    if (!this.sweepInFlight) {
      this.sweepInFlight = this.sweep().finally(() => {
        this.sweepInFlight = null;
      });
    }
    return this.sweepInFlight;
  }

  private async sweep(): Promise<void> {
    // Union of every account the engine cares about: deployment-managed
    // accounts plus any account with a still-in-flight DB trade. Mirrors
    // the same set used by reconcilePendingTrades for consistency.
    const accountIds = new Set<number>(this.deps.realtimeDeployments().map((d) => d.accountId));
    try {
      for (const acctId of listAccountsWithReconcilableTrades()) accountIds.add(acctId);
    } catch {
      // best-effort: a DB hiccup shouldn't keep the watchdog from sweeping
      // the deployment-managed accounts.
    }
    if (accountIds.size === 0) return;
    this.unknownStops.seenThisPass.clear();
    this.pendingStops.seenThisPass.clear();

    // Track keys observed this tick so we can prune the two-strike map for
    // positions that no longer exist (closed since last tick = key stale).
    const observedKeys = new Set<string>();

    for (const accountId of accountIds) {
      // Dead account ids (Combine→XFA, expired sim) still appear via
      // listAccountsWithReconcilableTrades; skip rather than warn every tick.
      if (!this.deps.isAccountRegistered(accountId)) continue;

      const coverageSource = this.deps.stopCoverageSourceFor(accountId);
      let positions: Position[];
      // `"open-orders"` takes a single working-order snapshot and filters
      // it per position. `"order-map"` skips the list entirely and
      // verifies known SL orderIds from the engine's own order map one at
      // a time (the list-based filter mis-counted bracketed positions as
      // naked when the contractId-cache hadn't warmed and the string
      // fallback failed to match `pos.contractId`).
      let workingOrders: Order[] = [];
      // Before the fetch: the account view drops a read asked before a newer write.
      const askedAt = Date.now();
      try {
        if (coverageSource === "order-map") {
          positions = await this.deps.brokerForAccount(accountId).searchOpenPositions(accountId);
        } else {
          const broker = this.deps.brokerForAccount(accountId);
          [positions, workingOrders] = await Promise.all([
            broker.searchOpenPositions(accountId),
            broker.searchOpenOrders(accountId, { forceFresh: true }),
          ]);
        }
      } catch (err) {
        this.deps.logEvent(
          "naked_watchdog_lookup_failed",
          ENGINE_SCOPE,
          `Naked-position watchdog: lookup failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId },
        );
        continue;
      }
      recordPositions(accountId, positions, "sweep", askedAt);
      if (coverageSource !== "order-map") recordOrders(accountId, workingOrders, "sweep", askedAt);

      // Scope to positions the engine opened on this account — D-16. A
      // deployment existing is not a claim over a position; a trade row is.
      // Hand-trading on a deployed instrument is D-2's business and nobody
      // else's.
      const managedContractIds = this.collectManagedContractIds(accountId);
      if (managedContractIds.size === 0) continue;

      // `"order-map"` only: precompute pos.contractId → deploymentIds
      // owning it, used to scope the SL-coverage lookup to the right
      // position. Built from realtimeDeployments + reconcilable DB trades
      // — same union as collectManagedContractIds. Resolver lookups are
      // cached (15min TTL) so the per-tick cost is negligible.
      const contractToDeployments = coverageSource === "order-map"
        ? await this.buildContractToDeploymentMap(accountId)
        : null;

      for (const pos of positions) {
        if (pos.size <= 0) continue;
        if (!managedContractIds.has(pos.contractId)) continue;
        // Scope is “the engine holds a trade row on this contract” and the
        // ticker is what that row happens to name — read separately, so a
        // missing symbol withholds a slot rather than narrowing a safety
        // sweep.
        const ticker = managedContractIds.get(pos.contractId) ?? null;
        const key = `${accountId}:${pos.contractId}:${pos.type}`;
        observedKeys.add(key);

        // A long closes via Sell and a short via Buy. Require enough total
        // stop size on that side to cover the position.
        const closingSide: OrderSide =
          pos.type === POSITION_TYPE_LONG ? ORDER_SIDE_SELL : ORDER_SIDE_BUY;
        let stopSizeOnClosingSide = 0;
        if (coverageSource === "order-map") {
          const coverage = await this.sumAliveTradovateSlCoverage(
            accountId,
            contractToDeployments?.get(pos.contractId) ?? new Set<string>(),
          );
          if (coverage === null) {
            this.nakedPositionObservations.delete(key);
            continue;
          }
          stopSizeOnClosingSide = coverage;
        } else {
          for (const o of workingOrders) {
            if (o.contractId !== pos.contractId) continue;
            // TP limits don't bound downside, so they are not coverage.
            if (o.type !== ORDER_TYPE_STOP_MARKET) continue;
            if (o.side !== closingSide) continue;
            if (!LIVE_ORDER_STATUSES.has(o.status)) continue;
            // Pending is live, but only for a bounded run of passes — a stop
            // the gateway never promotes out of it is no cover.
            if (o.status === ORDER_STATUS_PENDING && this.transitionalPassCount(this.pendingStops, o.id, accountId, "Pending", "working") > MAX_UNKNOWN_COVERAGE_PASSES) {
              continue;
            }
            stopSizeOnClosingSide += o.size;
          }
        }

        const naked = stopSizeOnClosingSide < pos.size;
        if (!naked) {
          this.nakedPositionObservations.delete(key);
          continue;
        }

        // Cooldown after a recent flatten attempt: the market order may
        // still be in flight or filling. Shared with D-2 enforcement, which
        // reaches the same position by the opposite predicate — see
        // engine-flatten-cooldown.ts.
        if (this.deps.flattenCooldown.active(accountId, pos.contractId)) continue;

        const sideLabel = pos.type === POSITION_TYPE_LONG ? "LONG" : "SHORT";
        if (!this.nakedPositionObservations.has(key)) {
          this.nakedPositionObservations.add(key);
          this.deps.logEvent(
            "naked_position_observed",
            ENGINE_SCOPE,
            `Naked position observed (account ${accountId}, ${pos.contractId}, ${sideLabel} ${pos.size}, no SL on closing side) — will flatten on next tick if still naked. SL size found=${stopSizeOnClosingSide}, required=${pos.size}.`,
            { accountId, contractId: pos.contractId, ticker },
          );
          continue;
        }

        // Two strikes — flatten. The market order is unbracketed by
        // design: the watchdog itself will catch any residual position
        // on the next tick if this flatten doesn't fully clear (partial
        // fill, broker error). Keep it simple.
        //
        // The sweep survives `stop()`, so a lost lease does not disarm it. The
        // strike is kept: the holder's own watchdog owns the position now.
        if (!this.mayFlatten()) return;

        // Stamped *before* the submit, not after it. The window the cooldown
        // exists to close is the round trip itself, and stamping on the far
        // side of the await leaves the other flatten actor free for exactly
        // its duration.
        this.deps.flattenCooldown.note(accountId, pos.contractId, "watchdog");
        const outcome = await this.flattenNakedPosition(accountId, pos.contractId, ticker, pos.size, closingSide, sideLabel, stopSizeOnClosingSide);
        if (outcome.kind === "refused") {
          // Nothing is on the book, so the stamp guards nothing and the strike
          // stands: the next tick flattens again (A37). `release` cannot drop
          // another actor's stamp.
          this.deps.flattenCooldown.release(accountId, pos.contractId, "watchdog");
          continue;
        }
        this.nakedPositionObservations.delete(key);

        // Cancel the surviving bracket legs *after* the close, not before it.
        // D-2's equivalent path cancels first, and is right to: it is claiming
        // a position whose working orders it has no protection interest in.
        // Here they are the only cover this position has left, and a cancel
        // round-trip in front of the market order both delays the urgent
        // action and — when the flatten is then rejected — strips a
        // partially-covering stop off a position that stays open. The residual
        // window is one cancel round-trip, and a failure inside it is loud.
        //
        // `contractToDeployments` being non-null is the gate: it exists only
        // for `"order-map"` accounts, which is the same statement as "this
        // broker's bracket legs are in `tradovate_order_map`". Every other
        // broker's legs are found on the book.
        if (outcome.kind !== "accepted") continue;
        const flattenOrderId = outcome.orderId;
        if (contractToDeployments) {
          await this.cancelMappedBracketsAfterFlatten(
            accountId,
            pos.contractId,
            ticker,
            contractToDeployments.get(pos.contractId) ?? new Set<string>(),
          );
        } else {
          await this.cancelClosingSideOrdersAfterFlatten(accountId, pos.contractId, ticker, closingSide, flattenOrderId);
        }
      }
    }

    // Prune two-strike entries for positions that closed between ticks.
    for (const key of Array.from(this.nakedPositionObservations)) {
      if (!observedKeys.has(key)) this.nakedPositionObservations.delete(key);
    }
    for (const run of [this.unknownStops, this.pendingStops]) {
      for (const orderId of Array.from(run.passes.keys())) {
        if (!run.seenThisPass.has(orderId)) run.passes.delete(orderId);
      }
    }
  }

  /** Contracts the engine claims on `accountId` for the purposes of the
   * naked-position watchdog: the contractId on every still-reconcilable DB
   * trade for this account, and nothing else — **mapped to the ticker that
   * trade names**, which is what this sweep's Activity lines render.
   *
   * The value rides along rather than being looked up separately because
   * the scope and the symbol come from one fact: the trade row. A sweep
   * that resolved a symbol out of the contract id would be answering a
   * question the deployment had already answered.
   *
   * **A deployment existing is not a claim over a position — D-16.** This
   * used to union the resolved contract of every `isLegInExitLoop`
   * deployment, which put a contract in scope because a *deployment*
   * existed rather than because a position the engine opened existed, and
   * `isLegInExitLoop` carries no session-window check so out-of-hours made
   * no difference. A correctly bracketed hand trade on a deployed
   * instrument was inspected, read as naked, and force-closed — three times
   * on the soak. A hand position has exactly one engine actor and it is
   * D-2, whose flatten already cancels the working orders it leaves behind.
   *
   * **The cost is accepted, not overlooked:** an engine position whose trade
   * row is missing or stale is invisible to this sweep, and the deployment
   * half used to backstop some of that by accident. Revisit only if the
   * null-mirror cause turns out to lose trade rows rather than just the
   * in-memory mirror. */
  private collectManagedContractIds(accountId: number): Map<string, string> {
    // The `try` covers the read and nothing else, so the catch's claim —
    // "no contract is in scope on this account this tick" — is enforced by
    // the early return rather than by trusting the mapping below never to
    // throw. A throw mid-loop would otherwise leave a partly built map on
    // the path that decides which positions a flatten may touch.
    let rows: StrategyTrade[];
    try {
      rows = getReconcilableTrades(accountId);
    } catch (err) {
      // Nothing else scopes this sweep any more, so a failed read means the
      // account is uncovered for the tick. Say so rather than returning an
      // empty set that reads like "no open trades".
      this.deps.logEvent(
        "naked_watchdog_rows_unreadable",
        ENGINE_SCOPE,
        `Naked-position watchdog: reconcilable-trade read failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)} — no contract is in scope on this account this tick.`,
        { accountId },
      );
      return new Map();
    }
    const managed = new Map<string, string>();
    for (const t of rows) {
      // The trade row carries the deployment’s own ticker, so the sweep’s
      // scope and its rendered symbol come from one read. Nothing is
      // derived from the contract id here — the deployment already said
      // what it trades.
      managed.set(t.contractId, t.ticker.replace(/^\//, ""));
    }
    return managed;
  }

  /** Tradovate watchdog helper: build pos.contractId → deploymentIds for
   *  the requested account, so the per-position SL-coverage lookup and the
   *  post-flatten bracket cancel can find the right deployment(s).
   *
   *  Still unions live realtime legs with reconcilable DB trades, which is
   *  wider than `collectManagedContractIds` since D-16 narrowed that to the
   *  trade rows. Deliberately: each deployment maps only to *its own*
   *  resolved contract, so the extra entries are on contracts this sweep
   *  never inspects, and D-16 is explicit that the order-map arm is correct
   *  for engine-opened positions and must not be rewritten alongside it. */
  private async buildContractToDeploymentMap(
    accountId: number,
  ): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const add = (contractId: string, deploymentId: string): void => {
      let set = map.get(contractId);
      if (!set) {
        set = new Set<string>();
        map.set(contractId, set);
      }
      set.add(deploymentId);
    };
    for (const d of this.deps.realtimeDeployments()) {
      if (!this.deps.isLegInExitLoop(d)) continue;
      if (d.accountId !== accountId) continue;
      try {
        const contract = await this.deps.resolveContract(d.ticker, d.accountId);
        add(executionContractId(contract), d.id);
      } catch {
        // This is the only handler for a resolve failure on this path —
        // `collectManagedContractIds` stopped resolving contracts at D-16, so
        // the "it already warns over there" this comment used to claim is
        // false. Silence is still right, and narrowly: every contract the
        // sweep actually inspects comes from the trade-row arm below, which
        // supplies its own deploymentId, so a failed resolve here can only
        // drop an entry on a contract nothing looks at. A resolver that is
        // persistently down is loud elsewhere — `processDeployment` and
        // `dispatchTickExit` both resolve per tick and log. If this arm ever
        // becomes a scope source again, it needs its own warn.
      }
    }
    try {
      for (const t of getReconcilableTrades(accountId)) {
        add(t.contractId, t.deploymentId);
      }
    } catch {
      // best-effort
    }
    return map;
  }

  /** Tradovate watchdog helper: count alive bracket-SL `orderQty` for the
   *  given deployments by reading `tradovate_order_map` for live SL rows
   *  and verifying each via `/order/item`. Map rows that resolve to a
   *  terminal broker state are stamped terminal_at in passing so the
   *  next tick's lookup is cheaper.
   *
   *  Returns `null` on any broker REST failure (inconclusive — caller skips
   *  naked check that tick). Returns a number only when all lookups succeeded. */
  private async sumAliveTradovateSlCoverage(
    accountId: number,
    deploymentIds: Set<string>,
  ): Promise<number | null> {
    if (deploymentIds.size === 0) {
      return 0;
    }
    const client = this.deps.defaultTradovateClient();
    if (!client) {
      return 0;
    }
    let mappings: ReturnType<typeof findActiveOrderMappingsByAccount>;
    try {
      mappings = findActiveOrderMappingsByAccount(accountId, "sl");
    } catch (err) {
      this.deps.logEvent(
        "naked_watchdog_coverage_unreadable",
        ENGINE_SCOPE,
        `Naked-position watchdog (Tradovate): order-map read failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)} — skipping naked check this tick`,
        { accountId },
      );
      return null;
    }
    let coverage = 0;
    for (const m of mappings) {
      if (!deploymentIds.has(m.deploymentId)) {
        continue;
      }
      let order: Awaited<ReturnType<typeof client.getOrder>>;
      try {
        order = await client.getOrder(m.orderId, accountId);
      } catch (err) {
        this.deps.logEvent(
          "naked_watchdog_coverage_unreadable",
          ENGINE_SCOPE,
          `Naked-position watchdog (Tradovate): /order/item failed for orderId ${m.orderId}: ${err instanceof Error ? err.message : String(err)} — coverage inconclusive, skipping naked check this tick`,
          { accountId },
        );
        return null;
      }
      if (!order) {
        continue;
      }
      // The broker's own live set, `Unknown` included. A private copy here
      // once omitted it, so a transient `Unknown` stamped a live SL terminal,
      // hid it from every later read, and the covered position was flattened.
      if (!TRADOVATE_CANCELABLE_STATUSES.has(order.ordStatus)) {
        try {
          markTradovateOrderTerminal(m.orderId);
        } catch {
          // best-effort cleanup; next tick will retry
        }
        continue;
      }
      // ...but only for a bounded run of passes, without stamping it
      // terminal: a stop that stays `Unknown` is treated as no cover, and a
      // later live read counts again.
      if (order.ordStatus === TRADOVATE_UNKNOWN_STATUS && this.transitionalPassCount(this.unknownStops, m.orderId, accountId, "Unknown", "live") > MAX_UNKNOWN_COVERAGE_PASSES) {
        continue;
      }
      // Use the qty recorded at place time — /order/item doesn't return
      // orderQty reliably on single-item lookups. m.qty is always set to
      // order.size when the SL was placed (defaults to 1 for pre-migration rows).
      coverage += m.qty;
    }
    return coverage;
  }

  /** This pass's count of consecutive transitional reads for one stop,
   *  counted once per pass however many positions visit it; announced the
   *  pass it stops counting as cover. */
  private transitionalPassCount(
    run: TransitionalStopRun,
    orderId: number,
    accountId: number,
    statusLabel: "Unknown" | "Pending",
    recoveredLabel: "live" | "working",
  ): number {
    if (run.seenThisPass.has(orderId)) return run.passes.get(orderId) ?? 0;
    run.seenThisPass.add(orderId);
    const passes = (run.passes.get(orderId) ?? 0) + 1;
    run.passes.set(orderId, passes);
    if (passes === MAX_UNKNOWN_COVERAGE_PASSES + 1) {
      const arm = statusLabel === "Unknown" ? " (Tradovate)" : "";
      this.deps.logEvent(
        "naked_watchdog_coverage_unreadable",
        ENGINE_SCOPE,
        `Naked-position watchdog${arm}: stop #${orderId} on account ${accountId} has reported ${statusLabel} for ${passes} passes in a row — no longer counted as cover until the broker reports it ${recoveredLabel} again.`,
        { accountId },
      );
    }
    return passes;
  }

  /** Returns the closing order's id when accepted; otherwise whether the
   *  failure was the broker's refusal or an outcome we cannot see. The caller
   *  cancels the surviving bracket legs only on an id — a failed flatten
   *  leaves an open position that still needs them — and keeps the id out of
   *  that cancel. */
  private async flattenNakedPosition(
    accountId: number,
    contractId: string,
    /** The rendered symbol this sweep’s Activity lines name, or null
     *  when the trade row scoping it named none. */
    ticker: string | null,
    size: number,
    closingSide: OrderSide,
    sideLabel: string,
    stopSizeFound: number,
  ): Promise<FlattenOutcome> {
    // No deployment scope here — this fires for any naked position on a
    // managed account, including phantom positions that don't map to a
    // deployment. Use the contractId as the customTag identity source so
    // the helper still produces a unique, length-safe tag. Shape:
    // `s_<8charId>_<~9char ts base36>_<4char rand>` ≈ 25 chars, well under
    // Topstep's ~64-char silent-500 ceiling. The "s" prefix is part of the
    // existing `"e" | "x" | "s"` union in buildCustomTag — no widening.
    const customTag = this.deps.buildCustomTag("s", contractId);
    const order: PlaceOrderRequest = {
      accountId,
      contractId,
      type: ORDER_TYPE_MARKET,
      side: closingSide,
      size,
      customTag,
    };

    this.deps.logEvent(
      "naked_position_flatten",
      ENGINE_SCOPE,
      `[SAFETY] Flattening naked position: account ${accountId}, ${contractId}, ${sideLabel} ${size}, observed naked across two watchdog ticks. SL size on closing side=${stopSizeFound}, required=${size}. Submitting market ${closingSide === ORDER_SIDE_BUY ? "BUY" : "SELL"} ${size} (reason=safety_no_bracket).`,
      { accountId, contractId, ticker },
    );

    try {
      const result = await trackOrderRequest(() => this.deps.brokerForAccount(accountId).placeOrder(order));
      this.deps.logEvent(
        "naked_position_flatten_submitted",
        ENGINE_SCOPE,
        `[SAFETY] Naked-position flatten submitted: account ${accountId}, ${contractId}, order #${result.orderId}.`,
        { accountId, contractId, ticker },
      );
      return { kind: "accepted", orderId: result.orderId };
    } catch (err) {
      // The plugin's classification, the one `maybeOrphanFromBrokerError`
      // reads: an unclaimed error answers null and takes the unconfirmed arm.
      // Topstep's typed place refusals (codes 1–5 and 8–10, A120) take the
      // refused arm; OrderPending (6), UnknownError (7) and transport failures
      // stay unclaimed, because the flatten may already be booked.
      const kind = this.deps.brokerErrorKind(err);
      const refused = kind !== null && ENTRY_REFUSAL_KINDS.has(kind);
      const retry = refused
        ? `the broker refused it, so the watchdog retries in ${REFUSED_FLATTEN_RETRY_WINDOW}`
        : `the outcome is unconfirmed, so the watchdog retries in ${UNCONFIRMED_FLATTEN_RETRY_WINDOW}`;
      this.deps.logEvent(
        "naked_position_flatten_rejected",
        ENGINE_SCOPE,
        // The consequence leads and the broker's body trails, because this
        // line is a flagged event's alert title when no symbol resolves and
        // the 256-cap would otherwise cut exactly the clause that matters.
        `[SAFETY] Naked-position flatten REJECTED — POSITION REMAINS UNPROTECTED, ${retry}: account ${accountId}, ${contractId}, ${sideLabel} ${size}. Broker said: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId, ticker },
      );
      this.deps.maybeOrphanFromBrokerError(err, accountId);
      return refused ? { kind: "refused" } : { kind: "unconfirmed" };
    }
  }

  /**
   * Cancel the bracket legs the flatten just orphaned.
   *
   * The closing market order flattens the position and leaves the OSO's SL
   * and TP resting. **Both legs sit on the closing side**, so against a flat
   * account either one filling *opens* an unbracketed position in the
   * opposite direction — observed 2026-05-14 and reproduced 2026-08-26 with
   * two five-lot buy orders and no position behind them.
   *
   * `tradovate_order_map` is the id source for the same reason it is the
   * coverage source: every engine bracket leg is in it by construction, and
   * under D-16 this sweep only ever reaches positions the engine opened.
   *
   * **The filter is by deployment, not by contract, and that is safe only
   * under an invariant this helper cannot see.** `tradovate_order_map` has no
   * contract column, so `findActiveOrderMappingsByAccount` hands back every
   * live SL/TP those deployments hold on the account and the cancel takes all
   * of them. `contractLocks` admits one deployment per `(account, contract)`
   * and one open position per deployment, so the set cannot today contain a
   * leg belonging to another contract. Its D-2 sibling `expectedByContract`
   * leans on the same lock and says so; this one did not. **Add a
   * `contract_id` column before that invariant is weakened, not after.**
   *
   * A failed cancel logs at `error` — that is the armed-reverse state itself,
   * and it must not be swallowed. The row is stamped terminal only when the
   * order is known not to be resting: on a successful cancel, or on a
   * rejection that says it was already terminal. Anything else has to stay
   * visible to the next tick's coverage read.
   */
  private async cancelMappedBracketsAfterFlatten(
    accountId: number,
    contractId: string,
    ticker: string | null,
    deploymentIds: ReadonlySet<string>,
  ): Promise<void> {
    if (deploymentIds.size === 0) {
      // Not the same statement as "there was nothing to cancel", and this is
      // the one safety path where the difference is money. `contractToDeploy-
      // ments` and `managedContractIds` come from two separate
      // `getReconcilableTrades()` reads, so a reconciler tick closing the row
      // between them lands here with the flatten already submitted — brackets
      // resting, and nothing able to name them.
      this.deps.logEvent(
        "orphan_bracket_unresolved",
        ENGINE_SCOPE,
        `[SAFETY] Naked-position flatten: no deployment resolved for account ${accountId}, ${contractId} — its bracket legs could not be looked up and may still be resting against a now-flat position, where filling one OPENS an unbracketed reverse. Check the book by hand.`,
        { accountId, contractId, ticker },
      );
      return;
    }
    let mappings: ReturnType<typeof findActiveOrderMappingsByAccount>;
    try {
      mappings = findActiveOrderMappingsByAccount(accountId, ["sl", "tp"]);
    } catch (err) {
      this.deps.logEvent(
        "orphan_bracket_lookup_failed",
        ENGINE_SCOPE,
        `[SAFETY] Naked-position flatten: bracket lookup failed for account ${accountId}, ${contractId}: ${err instanceof Error ? err.message : String(err)} — SL/TP may still be resting against a now-flat position and would open a reverse. Check the book by hand.`,
        { accountId, contractId, ticker },
      );
      return;
    }
    const targets = mappings.filter((m) => deploymentIds.has(m.deploymentId));
    // The common and correct silence: every leg the deployment held is already
    // stamped terminal, so there is genuinely nothing resting.
    if (targets.length === 0) return;

    const broker = this.deps.brokerForAccount(accountId);
    // Parallel for the same reason `cancelTrackedBrackets` is: the armed
    // window is what this is closing, so it should be one round-trip wide
    // rather than one per leg.
    await Promise.all(
      targets.map(async (m) => {
        const label = m.role.toUpperCase();
        try {
          await broker.cancelOrder(m.orderId, accountId);
        } catch (err) {
          // An already-terminal rejection is proof the armed-reverse state
          // does not exist, so it must not take the loud arm — and the row has
          // to be stamped, because nothing else will: `sumAliveTradovate-
          // SlCoverage` reads role "sl" only, so a `tp` whose terminal frame
          // was missed stays alive forever and re-produces this rejection, and
          // this line, on every future flatten for the deployment. Same view
          // the sibling path takes in `cancelTrackedBrackets`.
          if (this.deps.rejectionProvesTerminal(err)) {
            try {
              markTradovateOrderTerminal(m.orderId);
            } catch {
              // best-effort bookkeeping, as below.
            }
            this.deps.logEvent(
              "orphan_bracket_already_terminal",
              ENGINE_SCOPE,
              `[SAFETY] Naked-position flatten: ${label} #${m.orderId} on account ${accountId}, ${contractId} was already terminal at the broker: ${err instanceof Error ? err.message : String(err)} — nothing is resting, stamping the row so the next flatten does not re-report it.`,
              { accountId, contractId, ticker },
            );
            return;
          }
          this.deps.logEvent(
            "orphan_bracket_cancel_failed",
            ENGINE_SCOPE,
            `[SAFETY] Naked-position flatten: cancel of ${label} #${m.orderId} FAILED on account ${accountId}, ${contractId}: ${err instanceof Error ? err.message : String(err)} — it may still be resting against a now-flat position, and it rests on the closing side, so filling it OPENS an unbracketed reverse. Cancel it by hand.`,
            { accountId, contractId, ticker },
          );
          this.deps.maybeOrphanFromBrokerError(err, accountId);
          return;
        }
        try {
          markTradovateOrderTerminal(m.orderId);
        } catch {
          // best-effort bookkeeping; the order is already cancelled at the
          // broker and the next tick's /order/item lookup re-stamps it.
        }
        this.deps.logEvent(
          "orphan_bracket_cancelled",
          ENGINE_SCOPE,
          `[SAFETY] Naked-position flatten: cancelled orphaned ${label} #${m.orderId} on account ${accountId}, ${contractId}.`,
          { accountId, contractId, ticker },
        );
      }),
    );
  }

  /**
   * The `"open-orders"` arm of the post-flatten cancel (Topstep): every live
   * stop or limit on the closing side of the flattened contract, read from
   * the book after the flatten. Topstep's legs do not cancel when the
   * position goes flat, and they rest on the closing side, so filling one
   * opens an unbracketed reverse.
   *
   * The book, not the trade row's ids: Topstep rows routinely carry
   * `tp=null sl=null`, so the ids would cancel nothing in exactly the case
   * this exists for. The read is fresh because the pre-flatten snapshot can
   * miss a leg that went on since; the flatten's own order is excluded by id;
   * Pending counts with Working, as in `verifyExitClean`'s predicate. A hand
   * stop on that contract goes too — the whole position was just closed, the
   * trade force-flat already accepts. Nothing is stamped: there is no map row.
   */
  private async cancelClosingSideOrdersAfterFlatten(
    accountId: number,
    contractId: string,
    ticker: string | null,
    closingSide: OrderSide,
    flattenOrderId: number,
  ): Promise<void> {
    const broker = this.deps.brokerForAccount(accountId);
    let orders: Order[];
    try {
      orders = await broker.searchOpenOrders(accountId, { forceFresh: true });
    } catch (err) {
      this.deps.logEvent(
        "orphan_bracket_lookup_failed",
        ENGINE_SCOPE,
        `[SAFETY] Naked-position flatten: order lookup failed for account ${accountId}, ${contractId}: ${err instanceof Error ? err.message : String(err)} — a stop or target may still be resting against a now-flat position and would open a reverse. Check the book by hand.`,
        { accountId, contractId, ticker },
      );
      this.deps.maybeOrphanFromBrokerError(err, accountId);
      return;
    }
    const targets = orders.filter((o) => o.id !== flattenOrderId && isLiveProtectiveLeg(o, contractId, closingSide));
    await Promise.all(
      targets.map(async (o) => {
        try {
          await broker.cancelOrder(o.id, accountId);
        } catch (err) {
          if (this.deps.rejectionProvesTerminal(err)) {
            this.deps.logEvent(
              "orphan_bracket_already_terminal",
              ENGINE_SCOPE,
              `[SAFETY] Naked-position flatten: order #${o.id} on account ${accountId}, ${contractId} was already terminal at the broker: ${err instanceof Error ? err.message : String(err)} — nothing is resting.`,
              { accountId, contractId, ticker },
            );
            return;
          }
          this.deps.logEvent(
            "orphan_bracket_cancel_failed",
            ENGINE_SCOPE,
            `[SAFETY] Naked-position flatten: cancel of order #${o.id} FAILED on account ${accountId}, ${contractId}: ${err instanceof Error ? err.message : String(err)} — it may still be resting against a now-flat position, and it rests on the closing side, so filling it OPENS an unbracketed reverse. Cancel it by hand.`,
            { accountId, contractId, ticker },
          );
          this.deps.maybeOrphanFromBrokerError(err, accountId);
          return;
        }
        this.deps.logEvent(
          "orphan_bracket_cancelled",
          ENGINE_SCOPE,
          `[SAFETY] Naked-position flatten: cancelled orphaned order #${o.id} on account ${accountId}, ${contractId}.`,
          { accountId, contractId, ticker },
        );
      }),
    );
  }
}
