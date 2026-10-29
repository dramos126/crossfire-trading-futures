// Realtime event cluster extracted from engine.ts. These are the
// handlers a broker's account feed and the market hub push into: adapter
// handler registration, the position open/close fast paths, the Layer 1
// fill-buffer append, the two reconnect-gap replays and the market-trade
// fan-out.
//
// Like engine-reconcile.ts and unlike engine-watchdog.ts, this is a
// pure-function satellite: no engine state moved here. Every field the
// cluster writes — `DeploymentState.position`, `pendingEntrySessionKey`,
// `entryNotifiedTradeIds`, the fill buffer, `marketTradeWindowCount`,
// `MarketSub.lastTickPrice` — has writers outside the cluster too, so it
// is reached through `RealtimeDeps` and the engine keeps a one-line
// delegating method per function.

import type { BrokerCapabilities, BrokerRealtimeAdapter } from "@/lib/brokers/plugin";
import type { GatewayTrade } from "@/lib/brokers/topstep/signalr";
import type { Order, OrderSide, TradeFill } from "@/lib/brokers/types";
import { BrokerKind } from "@/lib/db/account-brokers";
import { ENGINE_SCOPE, type LogCategory, type Severity } from "@/lib/logging/vocabulary";
import type { StrategyTrade } from "@/lib/db/trade-types";
import {
  backfillExitOrderId,
  findRecentApproximatedTradeByAccountContract,
  findTradeByAccountContract,
  getTradeById,
  markEntryFilled,
} from "@/lib/db/trades";
import { entryFillValues } from "../engine-fill-format";
import { latchFilledEntry } from "../engine-entry-latch";
import { peekBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import { applyOrderEvent, applyPositionEvent } from "./account-view";
import type { ReconcilePosition } from "./engine-reconcile";
import type { Timeframe } from "@/lib/trading/domain";
import type { Broker } from "../../broker-access/broker";
import type {
  BufferSlot,
  ContractSub,
  DeploymentState,
  LogSubject,
  MarketSub,
  PreResolvedExit,
} from "../engine";

/** How far back a reconnect-gap replay will ask for fills when the
 *  account's last-event anchor is older than this (or absent). Past the
 *  cap the cold-start Layer 2/3 paths own recovery, so widening it buys
 *  a longer `searchTrades` scan and nothing else. */
const REPLAY_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Slack added to the upper bound of a replay window. The broker stamps a
 *  fill with its own clock and indexes it after the fact, so a window
 *  ending at `now` drops the fill that arrived during the reconnect. */
const REPLAY_SAFETY_PAD_MS = 60_000;

/**
 * Reconnect-gap replay window for one account. Both brokers' replays
 * compute it identically off different anchors — Topstep from the
 * engine's own `lastTopstepEventAt`, Tradovate from the pre-drop event
 * time the adapter carries on the reconnect signal — and the two used to
 * carry their own copy of the cap and the pad.
 *
 * A zero anchor means the account has delivered nothing this process, so
 * the cap *is* the window.
 */
export function replayWindow(
  lastEventAt: number,
  now: number,
): { startMs: number; endMs: number } {
  return {
    startMs: lastEventAt > 0
      ? Math.max(lastEventAt, now - REPLAY_MAX_LOOKBACK_MS)
      : now - REPLAY_MAX_LOOKBACK_MS,
    endMs: now + REPLAY_SAFETY_PAD_MS,
  };
}

/**
 * The engine surface this cluster reaches, threaded explicitly so no
 * satellite has to hold the engine or flip an access modifier.
 *
 * Each member is narrowed to the value the cluster consumes rather than
 * the accessor it used to call — `pluginIdFor` and `capabilitiesFor`
 * rather than `pluginFor`, `bufferSlotFor` rather than the fill buffer,
 * `marketSubFor` rather than the subscription map.
 *
 * **Every member whose engine-side access was synchronous is
 * synchronous here.** Wrapping `bufferSlotFor`, `stateFor`,
 * `reconcileExitFromBuffer` or `discardBufferSlot` in a promise would
 * park an await between reading `DeploymentState.position` and the exit
 * dispatch that follows it — the race engine.md's exit hard rule exists
 * to prevent. It would type-check and pass every test.
 */
export interface RealtimeDeps {
  log: (
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ) => void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category. See `TradingEngine.logEvent`. */
  logEvent: (event: string, deploymentId: string, message: string, subject?: LogSubject) => void;

  // ── broker routing ────────────────────────────────────────────────
  brokerForAccount: (accountId: number) => Broker;
  brokerKindFor: (accountId: number) => BrokerKind;
  /** The plugin's id, not the plugin. Three sites branch on it for
   *  observability policy — what to write to the engine ring — which is
   *  deliberately still identity-shaped rather than a capability. */
  pluginIdFor: (kind: BrokerKind) => string;
  /** The capability record, not the plugin that owns it. */
  capabilitiesFor: (kind: BrokerKind) => BrokerCapabilities;
  /** Every registered plugin's account-event adapter. */
  realtimeAdapters: () => BrokerRealtimeAdapter[];

  // ── the gate and the anchors the wiring drives ────────────────────
  /** Whether this account's realtime events may act on engine state. Two
   *  arms — the process flag for every broker, plus `isRunning()` for a
   *  transport someone else keeps up. Stays on the engine because
   *  `isRunning()` reads the tick interval. */
  realtimeEventsAllowed: (accountId: number) => boolean;
  noteRealtimeEvent: (accountId: number) => void;
  /** Reconnect-replay dispatch, including the Topstep sweep coalescing.
   *  Stays on the engine with its two in-flight/queued flags.
   *  `lastEventAtBeforeReconnect` is the Tradovate replay's window anchor,
   *  carried on the reconnect signal; the Topstep sweep ignores it. */
  replayFillsAfterReconnect: (accountId: number, lastEventAtBeforeReconnect: number) => Promise<void>;

  // ── siblings, reached through the engine rather than directly ─────
  //
  // The engine's delegating methods are `vi.spyOn` targets in
  // engine.test.ts, which drives all four of these through
  // `wireRealtimeAdapters`. Calling the module functions directly would
  // leave those spies pointing at a method nothing calls.
  handleUserPositionEvent: (payload: {
    accountId: number;
    contractId: string;
    size: number;
    averagePrice: number;
    creationTimestamp: string;
  }) => Promise<void>;
  handleUserPositionClose: (accountId: number, contractId: string) => Promise<void>;
  appendBufferedFill: (brokerKind: BrokerKind, accountId: number, fill: TradeFill) => void;

  // ── per-deployment state ──────────────────────────────────────────
  /** Looked up rather than handed over as a map. The cluster writes
   *  through the returned object — `position.size`, `entryPrice`,
   *  `entryFilledAt` and `pendingEntrySessionKey` — which makes it one
   *  writer among several of the field the exit-latch rule guards. */
  stateFor: (deploymentId: string) => DeploymentState | undefined;
  markEnteredThisSession: (deploymentId: string, sessionKey: string, side: OrderSide) => void;
  /** Engine-owned, mutated here: trade ids whose entry embed already
   *  fired. Read and added to. */
  entryNotifiedTradeIds: Set<number>;
  notifyEntry: (
    trade: StrategyTrade,
    entryPrice: number,
    filledAt: string,
    filledSize?: number,
  ) => Promise<void>;

  // ── Layer 1 fill buffer ───────────────────────────────────────────
  bufferSlotKey: (accountId: number, contractId: string, tradeId: number) => string;
  bufferContractKey: (accountId: number, contractId: string) => string;
  openBufferSlot: (accountId: number, contractId: string, tradeId: number) => void;
  discardBufferSlot: (slotKey: string) => void;
  bufferSlotFor: (slotKey: string) => BufferSlot | undefined;
  /** Iteration only — the replays scan for accounts with live slots and
   *  must not be able to clear or re-key the map. */
  bufferSlots: () => IterableIterator<BufferSlot>;
  slotKeyForContract: (contractKey: string) => string | undefined;
  recentDedupFor: (contractKey: string) => Set<string> | undefined;

  // ── reconciliation ────────────────────────────────────────────────
  reconcileExitFromBuffer: (brokerKind: BrokerKind, trade: StrategyTrade) => PreResolvedExit | null;
  reconcileOneTrade: (
    trade: StrategyTrade,
    accountId: number,
    openOrders: Order[],
    openOrderIds: Set<number>,
    positionsByContract: Map<string, ReconcilePosition>,
    preResolvedExit: PreResolvedExit | null,
  ) => Promise<void>;
  healApproximatedExitFromFills: (trade: StrategyTrade, accountId: number) => Promise<boolean>;
  validateClosedTradePrices: (trade: StrategyTrade, accountId: number) => Promise<void>;
  /** Per-account event-arrival anchor, the lower bound of the Topstep
   *  replay window. */
  lastTopstepEventAt: (accountId: number) => number | undefined;

  // ── market hub fan-out ────────────────────────────────────────────
  noteTradeActivity: () => void;
  /** The market-trade counter the heartbeat reads and resets. */
  noteMarketTrade: () => void;
  marketSubFor: (contractId: string) => MarketSub | undefined;
  contractSubFor: (contractId: string, tf: Timeframe) => ContractSub | undefined;
  evaluateRealtimeExits: (contractId: string, price: number) => Promise<void>;
}

/**
 * Register the engine's handlers on every adapter, once, at
 * construction. Broker-agnostic: the adapters have already translated
 * into `Order` / `Position` / `TradeFill`, and every handler is told
 * which account fired rather than inferring it from which adapter did.
 */
export function wireRealtimeAdapters(deps: RealtimeDeps): void {
  for (const adapter of deps.realtimeAdapters()) {
    adapter.onPosition((accountId, position) => {
      if (!deps.realtimeEventsAllowed(accountId)) return;
      deps.noteRealtimeEvent(accountId);
      // Mirror the fast-path both brokers share: size === 0 → close,
      // size > 0 → entry confirmation. One canonical reconciliation
      // flow regardless of which broker pushed the event.
      void deps.handleUserPositionEvent({
        accountId,
        contractId: position.contractId,
        size: position.size,
        averagePrice: position.averagePrice,
        creationTimestamp: position.creationTimestamp,
      });
      // After the money handler: a throw in the display write must not skip it.
      applyPositionEvent(accountId, position);
    });
    adapter.onFill((accountId, fill) => {
      if (!deps.realtimeEventsAllowed(accountId)) return;
      deps.noteRealtimeEvent(accountId);
      const brokerKind = deps.brokerKindFor(accountId);
      // Tradovate-only, matching the order log above and for the same
      // reason. This is the paper trail for the Tradovate fill path —
      // the watchdog-flatten / orphaned-bracket investigation in
      // docs/bugs.md reads it.
      if (deps.pluginIdFor(brokerKind) === "tradovate") {
        deps.logEvent(
          "fill_frame",
          ENGINE_SCOPE,
          `Tradovate WS: fill acct=${accountId} id=${fill.id} orderId=${fill.orderId} size=${fill.size} fees=${fill.fees ?? "null"}`,
          { accountId, contractId: fill.contractId },
        );
      }
      deps.appendBufferedFill(brokerKind, accountId, fill);
    });
    adapter.onOrder((accountId, order) => {
      if (!deps.realtimeEventsAllowed(accountId)) return;
      deps.noteRealtimeEvent(accountId);
      applyOrderEvent(accountId, order);
      // Order events are observability-only — the reconciliation key is
      // the position event for both brokers. Logged for Tradovate only:
      // Topstep's user hub emits an order event per bracket update and
      // would flood the engine ring, which is why it has never been
      // logged here. **Deliberately still an identity branch after E5**
      // — what to write to the ring is observability policy, and a flag
      // for it would be a boolean naming a broker, not a capability.
      if (deps.pluginIdFor(deps.brokerKindFor(accountId)) !== "tradovate") return;
      deps.logEvent(
        "order_frame",
        ENGINE_SCOPE,
        `Tradovate WS: order acct=${accountId} id=${order.id} status=${order.status} size=${order.size}`,
        { accountId, contractId: order.contractId },
      );
    });
    adapter.onReconnect((accountId, lastEventAtBeforeReconnect) => {
      if (!deps.realtimeEventsAllowed(accountId)) return;
      // A zero anchor widens the Tradovate replay to its full 24h cap — the
      // safe direction when the signal carried none (never for Tradovate,
      // which always supplies it; Topstep omits it and ignores it anyway).
      deps.replayFillsAfterReconnect(accountId, lastEventAtBeforeReconnect ?? 0).catch((err) => {
        deps.logEvent(
          "replay_failed",
          ENGINE_SCOPE,
          `Reconnect-gap replay failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
          { accountId },
        );
      });
    });
  }
}

/**
 * Single entry point for broker adapters delivering normalized
 * `TradeFill` events into the Layer 1 buffer.
 *
 * Owns:
 *  - dedup on `(brokerKind, accountId, fill.id)` (slot-scoped),
 *  - slot-existence check + cross-slot redelivery warn-and-drop,
 *  - the cold-start "open opportunistically" rule — open a slot on
 *    first fill event for `(accountId, contractId)` if a trade row
 *    exists at that key (folded with row-creation slot opening; both
 *    idempotent).
 */
export function appendBufferedFill(
  deps: RealtimeDeps,
  brokerKind: BrokerKind,
  accountId: number,
  fill: TradeFill,
): void {
  const dedupKey = `${brokerKind}:${accountId}:${fill.id}`;
  const contractKey = deps.bufferContractKey(accountId, fill.contractId);

  // Cross-slot redelivery: the same fill id arrived after a prior slot
  // for this (accountId, contractId) was discarded. Drop with a warn
  // before any slot-creation side-effects so a redelivered fill
  // doesn't sneak into the next trade's fresh slot.
  const recent = deps.recentDedupFor(contractKey);
  if (recent?.has(dedupKey)) {
    deps.log(
      ENGINE_SCOPE,
      "warn",
      "trade",
      `Layer 1 cross-slot redelivery (account=${accountId} contract=${fill.contractId} fillId=${fill.id}) — dropping; possible transport replay or backfill landing on closed slot`,
      { accountId, contractId: fill.contractId },
    );
    return;
  }

  let slotKey = deps.slotKeyForContract(contractKey);

  // Cold-start "open opportunistically": a fill arrived before the
  // trade-row-creation hook ran, but a trade row exists at this key.
  // Open a slot now so the fill lands somewhere instead of being
  // dropped. Both this path and `openBufferSlot` are idempotent.
  if (!slotKey) {
    const trade = findTradeByAccountContract(accountId, fill.contractId);
    if (trade) {
      deps.openBufferSlot(accountId, fill.contractId, trade.id);
      slotKey = deps.slotKeyForContract(contractKey);
    }
  }
  if (!slotKey) {
    // A fill arrived for a closed approximated trade (no slot exists).
    // Only worth stamping when this broker's `searchTrades` cannot reach
    // back past a restart: the orderId is what the by-order lookup in
    // resolveExitFromFills needs to recover the fills on the next heal
    // pass. A time-ranged `searchTrades` finds them without it.
    if (deps.capabilitiesFor(brokerKind).historicalFillsRequireOrderLookup) {
      const stuck = findRecentApproximatedTradeByAccountContract(accountId, fill.contractId);
      if (stuck) {
        // Only stamp if this fill is on the closing side and isn't the
        // entry fill itself — the WS replay delivers all fills including
        // the opening fill, and stamping that as exitOrderId would make
        // resolveExitFromFills self-reference the entry order.
        const closingSide = stuck.side === 0 ? 1 : 0;
        // Guard against WS replay delivering fills from prior round-trips:
        // require the fill to be post-entry and on the closing side.
        const entryTs = stuck.entryFilledAt ?? stuck.entrySubmittedAt;
        // Deliberately not `isClosingFill` from engine-fill.ts, and not
        // named after it either: that classifier needs a live trade row's
        // bracket ids, which a stuck approximated row does not carry.
        // This is the weaker side-and-timestamp test, and it decides only
        // whether the orderId is worth stamping for the next heal pass.
        const isStampableExitFill =
          fill.side === closingSide &&
          fill.orderId !== stuck.entryOrderId &&
          new Date(fill.creationTimestamp) >= new Date(entryTs);
        if (isStampableExitFill) {
          backfillExitOrderId(stuck.id, fill.orderId);
          // Trigger an immediate heal rather than waiting for the next
          // 15s reconciler tick. The fill is live — /fill/list will
          // return it now. Without this, flatten-all exits stay
          // approximated until the next tick even though the fill data
          // is already in hand.
          void deps.healApproximatedExitFromFills(stuck, accountId).catch((err) => {
            deps.log(
              stuck.deploymentId,
              "warn",
              "trade",
              `Trade #${stuck.id} WS-triggered heal failed: ${err instanceof Error ? err.message : String(err)}`,
              { accountId, contractId: fill.contractId, tradeId: stuck.id },
            );
          });
        }
      }
    }
    return;
  }

  const slot = deps.bufferSlotFor(slotKey);
  if (!slot) {
    return;
  }

  // Slot-scoped dedup: silent no-op on duplicate within slot.
  if (slot.dedup.has(dedupKey)) {
    return;
  }

  slot.dedup.add(dedupKey);
  slot.fills.push(fill);
}

/**
 * Topstep reconnect-gap REST replay per
 * docs/proposals/userhub-trade-subscription.md §Reconnect-gap mitigation.
 *
 * For each active buffer slot belonging to a Topstep account, fire one
 * `broker.searchTrades(...)` over `[lastEventReceivedAt, now + 60s
 * pad]`, capped at 24h. Backfill via `appendBufferedFill` (idempotent
 * on the slot's dedup key). Beyond the 24h cap, fall through to
 * Layer 2/3 cold-start paths instead.
 */
export async function replayTopstepFillsAfterReconnect(deps: RealtimeDeps): Promise<void> {
  const now = Date.now();
  // Snapshot slots so concurrent appendBufferedFill writes don't race
  // the iteration. By-account so each broker-call fires once even if
  // a single account has multiple in-flight slots.
  const accountsToReplay = new Set<number>();
  for (const slot of deps.bufferSlots()) {
    if (deps.pluginIdFor(deps.brokerKindFor(slot.accountId)) !== "topstep") continue;
    accountsToReplay.add(slot.accountId);
  }
  for (const accountId of accountsToReplay) {
    const { startMs, endMs } = replayWindow(deps.lastTopstepEventAt(accountId) ?? 0, now);
    try {
      const fills = await deps.brokerForAccount(accountId).searchTrades(
        accountId,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
      );
      for (const f of fills) {
        deps.appendBufferedFill(BrokerKind.Topstep, accountId, f);
      }
      deps.logEvent(
        "replay_completed",
        ENGINE_SCOPE,
        `Layer 1 reconnect-gap replay: account=${accountId} fetched ${fills.length} fills over [${new Date(startMs).toISOString()}, ${new Date(endMs).toISOString()}]`,
        { accountId },
      );
    } catch (err) {
      deps.logEvent(
        "replay_failed",
        ENGINE_SCOPE,
        `Layer 1 reconnect-gap replay failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)} — slot may miss fills delivered during the gap`,
        { accountId },
      );
    }
  }
}

/**
 * Tradovate reconnect-gap REST replay per
 * docs/proposals/userhub-trade-subscription.md §Reconnect-gap mitigation.
 * Tradovate analog of `replayTopstepFillsAfterReconnect`. Fired by the
 * adapter's `onReconnect` signal when its subscriber transitions back
 * to `subscribed` after a prior subscribe — which happens after any
 * inbound-silence reconnect, defensive token-refresh reconnect, or
 * socket-close reconnect. The signal is the transport's; the policy
 * below is the engine's.
 *
 * Window source: `lastEventAtBeforeReconnect`, the lower bound of the gap
 * the adapter carries on the reconnect signal. It cannot be read back off
 * the adapter's live `status(accountId)` — an ordinary reconnect's new
 * socket, and the rotation's replacement subscriber, have already bumped
 * `lastEventAt` to ~now by the time the hook fires. Backfill fires
 * `searchTrades` over `[lastEventAt, now + 60s pad]`, capped at 24h.
 * Beyond the cap, fall through to Layer 2/3 cold-start paths. Backfill via
 * `appendBufferedFill('tradovate', ...)` — idempotent on the slot's dedup
 * key so any fills already received via the WS post-resubscribe are
 * silently de-duped.
 */
export async function replayTradovateFillsAfterReconnect(
  deps: RealtimeDeps,
  accountId: number,
  lastEventAtBeforeReconnect: number,
): Promise<void> {
  const kind = deps.brokerKindFor(accountId);
  if (deps.pluginIdFor(kind) !== "tradovate") return;
  // Skip the replay if we have no active buffer slot for this account
  // — there's no slot to backfill into and `appendBufferedFill` would
  // drop every fill as out-of-system.
  let hasActiveSlot = false;
  for (const slot of deps.bufferSlots()) {
    if (slot.accountId === accountId) {
      hasActiveSlot = true;
      break;
    }
  }
  if (!hasActiveSlot) return;
  const now = Date.now();
  const { startMs, endMs } = replayWindow(lastEventAtBeforeReconnect, now);
  try {
    const fills = await deps.brokerForAccount(accountId).searchTrades(
      accountId,
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    );
    for (const f of fills) {
      deps.appendBufferedFill(BrokerKind.Tradovate, accountId, f);
    }
    deps.logEvent(
      "replay_completed",
      ENGINE_SCOPE,
      `Layer 1 reconnect-gap replay (tradovate): account=${accountId} fetched ${fills.length} fills over [${new Date(startMs).toISOString()}, ${new Date(endMs).toISOString()}]`,
      { accountId },
    );
  } catch (err) {
    deps.logEvent(
      "replay_failed",
      ENGINE_SCOPE,
      `Layer 1 reconnect-gap replay (tradovate) failed for account ${accountId}: ${err instanceof Error ? err.message : String(err)} — slot may miss fills delivered during the gap`,
      { accountId },
    );
  }
}

/**
 * Realtime handler for a broker position event. Maps the (accountId,
 * contractId) pair back to a strategy_trades row and triggers the
 * matching entry-fill / exit-fill reconcile path immediately.
 *
 * Idempotency invariants:
 *  - If `state.position.entryFilledAt` is already set, the entry-fill
 *    branch no-ops (we'd still call markEntryFilled but the SQL is a
 *    same-value update).
 *  - If the trade is already `closed` and not approximated, the exit
 *    branch no-ops via the DB filter (findRecentApproximatedTradeByAccountContract).
 *
 * Per-fill events are wired separately via the Layer 1
 * buffer (docs/proposals/userhub-trade-subscription.md). Fills feed
 * `appendBufferedFill(...)` and the position-close path drains
 * them ahead of the REST `searchTrades` fan-out. This handler stays
 * focused on entry-confirmation + close-detection; reconciliation of
 * exit price / PnL / fees is owned by the buffer drain or by Layer 2's
 * `resolveExitFromFills` fallback.
 */
export async function handleUserPositionEvent(
  deps: RealtimeDeps,
  payload: { accountId: number; contractId: string; size: number; averagePrice: number; creationTimestamp: string },
): Promise<void> {
  deps.logEvent(
    "position_frame",
    ENGINE_SCOPE,
    `User hub: position update accountId=${payload.accountId} contractId=${payload.contractId} size=${payload.size} avgPrice=${payload.averagePrice}`,
    { accountId: payload.accountId, contractId: payload.contractId },
  );

  if (payload.size === 0) {
    // Position closed. Fast-path the exit reconcile so the row finalizes
    // ahead of the 15s REST tick.
    await deps.handleUserPositionClose(payload.accountId, payload.contractId);
    return;
  }

  // Position open / partial. If we have a pending_entry trade for this
  // (account, contract), promote it now so BE / breakeven gates open
  // without waiting on REST. Bracket attribution still happens on the
  // next reconciler tick, in `reconcileOneTrade`'s `open` branch; the
  // Trade/search timestamp lookup does not run for a row promoted here —
  // the frame's timestamp below stands until the heal pass corrects it.
  const trade = findTradeByAccountContract(payload.accountId, payload.contractId);
  if (!trade) return;
  if (trade.status !== "pending_entry" && trade.status !== "open") return;

  // Persist entry_filled_at from the user-hub event timestamp BEFORE the
  // in-memory state guards below. Two reasons this has to happen first:
  //
  //   1) On engine restart we lose `state.activeTradeId` for live
  //      trades, so the guard at the next line bails — the state-rebuild
  //      path runs later. Without an early DB write, the row's
  //      entry_filled_at stays null forever for a trade that opened
  //      pre-restart.
  //
  //   2) `resolveExitFromFills` short-circuits when entryFilledAt is
  //      null (it can't safely scope fills to post-entry). That gates
  //      every PnL heal path. Trade/search occasionally returns 0
  //      entry-fill matches by entryOrderId (Topstep indexing
  //      idiosyncrasy on PnL=null fills), so the timestamp-heal pass
  //      can't be relied on as the only writer here.
  //
  // Use the user-hub event timestamp (sub-second accuracy from Topstep);
  // the timestamp-heal pass overwrites with the authoritative
  // Trade/search fill timestamp later if it differs.
  const filledAt = payload.creationTimestamp ?? new Date().toISOString();
  if (trade.entryFilledAt == null) {
    markEntryFilled(trade.id, payload.averagePrice, filledAt);
  }

  // Before the ownership guard below: an entry pending across a restart is
  // not this process's `activeTradeId`, and its fill must still latch.
  latchFilledEntry(deps, trade);

  const state = deps.stateFor(trade.deploymentId);
  if (!state || state.activeTradeId !== trade.id) return;

  // Mirror broker size onto the in-memory position so partial fills
  // (bracket-side flatten, manual broker close of one leg, etc.) don't
  // leave the engine tracking the original entry size. The size>0 guard
  // above already excluded the flat case — that's owned by the exit
  // path (handleUserPositionClose / placeExitOrder), which nulls the
  // whole position rather than zeroing size on it.
  if (state.position) {
    state.position.size = payload.size;
  }

  const alreadyPromoted = state.position?.entryFilledAt != null;
  if (!alreadyPromoted && state.position) {
    state.position.entryPrice = payload.averagePrice;
    state.position.entryFilledAt = filledAt;
  }

  // Bracket attribution path forks per broker.
  //
  // `"sync"`: brackets are stamped by `placeEntryOrder` the moment
  // `await broker.placeOrder` resolves, from the ids on the place
  // response. The position event no longer participates — the broker
  // emits a single position event on entry and nothing until close, so
  // a position-event-driven retry only ever got one shot and routinely
  // fired before placeOrder returned. The fast-path stamp makes that
  // retry both unnecessary and unreachable, so there is nothing to say
  // here.
  //
  // `"reconciler"`: the place response carries no bracket ids, so the
  // REST reconciler tick attributes them via `attributeBrackets`
  // (preEntryOrderIds diffed against `searchOpenOrders`).
  const attribution =
    deps.capabilitiesFor(deps.brokerKindFor(payload.accountId)).bracketAttribution;
  if (attribution === "reconciler" && !alreadyPromoted) {
    deps.logEvent(
      "entry_filled",
      trade.deploymentId,
      `Trade #${trade.id} entry confirmed via user hub @ ${payload.averagePrice} (REST reconciler will attribute brackets next tick)`,
      {
        accountId: payload.accountId,
        contractId: payload.contractId,
        tradeId: trade.id,
        values: entryFillValues(trade, payload.averagePrice, payload.size),
      },
    );
  }

  if (alreadyPromoted) return;

  // Fire the Discord entry notification from the realtime hub event so
  // sub-second round-trips still get an entry embed. The REST reconciler
  // paths (reconcileOneTrade + handleEntryClosedNoPosition) gate their
  // notifyEntry on Trade/search returning fills, which suffers indexing
  // lag — fast trades close before fills index, so the entry embed never
  // fires. The position event has everything we need (avgPrice, ts) and
  // arrives the moment Topstep books the position. Idempotency via
  // entryNotifiedTradeIds prevents double-fire when a later reconcile
  // path also reaches notifyEntry.
  if (!deps.entryNotifiedTradeIds.has(trade.id)) {
    deps.entryNotifiedTradeIds.add(trade.id);
    void deps.notifyEntry(trade, payload.averagePrice, filledAt, payload.size);
  }
}

/**
 * User-hub position-close fast path. Two cases:
 *
 *   (1) An in-flight trade exists ⇒ run the same exit-resolution path
 *       the REST reconciler runs (`reconcileOneTrade`'s !pos branch).
 *       This is what fixes the 15s lag on close detection.
 *
 *   (2) Trade is already closed but exit_approximated=true (or
 *       exit_filled_at is null) ⇒ try to upgrade the row's PnL from
 *       the bar-close approximation to real fills now that Topstep
 *       has confirmed the close. If Trade/search still hasn't
 *       indexed, no-op — heal pass picks it up later.
 *
 * Worth running both branches: on the same close event, an already-
 * closed-by-reconciler row gets promoted to authoritative PnL the
 * moment Topstep pushes the position event.
 */
export async function handleUserPositionClose(deps: RealtimeDeps, accountId: number, contractId: string): Promise<void> {
  const trade = findTradeByAccountContract(accountId, contractId);
  if (trade) {
    // Layer 1: attempt buffer drain ahead of REST. The slot is always
    // discarded in `finally` regardless of whether the drain attributed
    // the exit — a stale slot must not bleed into the next entry on
    // the same (accountId, contractId).
    let preResolvedExit: PreResolvedExit | null = null;
    const slotKey = deps.bufferSlotKey(accountId, contractId, trade.id);
    try {
      const brokerKind = deps.brokerKindFor(accountId);
      // Brief wait so an in-flight closing fill can land in the buffer
      // before we drain, on a transport whose position-flat frame can
      // arrive ahead of the fill frame. Zero means the two are ordered
      // — and the `> 0` guard matters: an unconditional
      // `setTimeout(…, 0)` is a macrotask yield on the exit path, which
      // is a behaviour change rather than a no-op.
      const graceMs = deps.capabilitiesFor(brokerKind).positionCloseGraceMs;
      if (graceMs > 0) {
        await new Promise((r) => setTimeout(r, graceMs));
      }
      // Trade row hot from DB — `findTradeByAccountContract` returned a
      // snapshot before any user-hub event might have fired
      // markEntryFilled in this tick. Re-read so the predicate gates
      // on the latest entryFilledAt.
      const fresh = getTradeById(trade.id) ?? trade;
      preResolvedExit = deps.reconcileExitFromBuffer(brokerKind, fresh);
      if (preResolvedExit) {
        deps.logEvent(
          "exit_reconciled",
          trade.deploymentId,
          `Layer 1 reconciled trade #${trade.id} (account=${accountId} contract=${contractId}) exit_resolution_source=buffer exitPrice=${preResolvedExit.exitPrice.toFixed(2)} pnl=${preResolvedExit.pnlDollars.toFixed(2)}`,
          { accountId, contractId, tradeId: trade.id },
        );
      }
    } catch (err) {
      deps.log(
        trade.deploymentId,
        "warn",
        "trade",
        `Layer 1 drain threw for trade #${trade.id}: ${err instanceof Error ? err.message : String(err)} — falling through to Layer 2`,
        { accountId, contractId, tradeId: trade.id },
      );
      preResolvedExit = null;
    } finally {
      deps.discardBufferSlot(slotKey);
    }

    try {
      const broker = deps.brokerForAccount(accountId);
      const [orders, positions] = await Promise.all([
        broker.searchOpenOrders(accountId, { forceFresh: true }),
        broker.searchOpenPositions(accountId),
      ]);
      // The side rides along, as on the REST pass (A44). Built here rather
      // than through `mapPositionsByContract`, so this cluster imports only a
      // type from the reconciler and none of its module graph.
      const positionsByContract = new Map<string, ReconcilePosition>(
        positions.map((p) => [p.contractId, { size: p.size, avgPrice: p.averagePrice, type: p.type }]),
      );
      const openOrderIds = new Set(orders.map((o) => o.id));
      await deps.reconcileOneTrade(
        trade,
        accountId,
        orders,
        openOrderIds,
        positionsByContract,
        preResolvedExit,
      );
    } catch (err) {
      deps.log(
        trade.deploymentId,
        "warn",
        "trade",
        `Realtime exit reconcile failed for trade #${trade.id}: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId, tradeId: trade.id },
      );
    }
    return;
  }

  // No in-flight trade. Check for a stuck-PnL closed row to heal.
  const stuck = findRecentApproximatedTradeByAccountContract(accountId, contractId);
  if (!stuck) return;
  try {
    await deps.healApproximatedExitFromFills(stuck, accountId);
  } catch (err) {
    deps.log(
      stuck.deploymentId,
      "warn",
      "trade",
      `Realtime PnL heal failed for trade #${stuck.id}: ${err instanceof Error ? err.message : String(err)}`,
      { accountId, contractId, tradeId: stuck.id },
    );
  }
  // Validate the post-heal row against Trade/search. Idempotent — if the
  // heal write got the right values, this is a no-op. Re-fetch so we
  // compare against what's actually in the DB now, not the stale snapshot.
  const fresh = getTradeById(stuck.id);
  if (fresh) {
    try {
      await deps.validateClosedTradePrices(fresh, accountId);
    } catch (err) {
      deps.log(
        stuck.deploymentId,
        "warn",
        "trade",
        `Realtime price validation failed for trade #${stuck.id}: ${err instanceof Error ? err.message : String(err)}`,
        { accountId, contractId, tradeId: stuck.id },
      );
    }
  }
}

export function handleTrade(deps: RealtimeDeps, contractId: string, trade: GatewayTrade | GatewayTrade[]): void {
  // Refreshes the watchdog anchor and clears its inline-retry counter —
  // any inbound trade proves the hub is alive.
  deps.noteTradeActivity();
  deps.noteMarketTrade();
  const marketSub = deps.marketSubFor(contractId);
  // In trade-time order: the aggregator drops a trade from a bucket it has
  // already closed, so a batch folded in arrival order across a boundary
  // would lose the closed bar's last trades.
  const trades = (Array.isArray(trade) ? trade : [trade])
    .map((t) => ({ t, ts: new Date(t.timestamp).getTime() }))
    .filter(({ ts }) => !isNaN(ts))
    .sort((a, b) => a.ts - b.ts);
  let latestPrice: number | null = null;
  let latestTs: string | null = null;
  for (const { t, ts } of trades) {
    // Bar aggregation only fires for engine-tracked contracts; browser-only
    // contracts (manual positions, no deployment) still flow through here
    // for SSE forwarding. Fan out to every aggregator bound to this contract
    // so 1m + 5m deployments on the same future both see every tick.
    if (marketSub) {
      for (const tf of marketSub.timeframes) {
        deps.contractSubFor(contractId, tf)?.aggregator.addTrade(t.price, t.volume, ts);
      }
    }
    latestPrice = t.price;
    latestTs = t.timestamp;
  }
  // Forward to the browser as the unrealized-PnL mark. Cheap when no
  // listeners are attached (broadcaster.emit is a noop). Done unconditionally
  // — even browser-tracked contracts the engine isn't deploying on.
  if (latestPrice != null && latestTs != null) {
    const bcast = peekBroadcaster();
    bcast?.emitMarketTrade(contractId, latestPrice, latestTs);
    // Tradovate positions surface their execution contractId (e.g. "MNQM6")
    // in the positions feed, not the Topstep id the market hub uses. Emit
    // under the execution alias so the UI's quote map key matches the
    // position's contractId and unrealized PnL resolves.
    const execId = marketSub?.contract.executionContractId;
    if (bcast && execId && execId !== contractId) {
      bcast.emitMarketTrade(execId, latestPrice, latestTs);
    }
  }
  if (!marketSub) return;
  // Realtime exit evaluation: only re-check when the price actually moved.
  // Dedup lives on marketSub (per-contract) so BE/session checks don't
  // fire N× per tick when N timeframes are bound to the same contract.
  if (latestPrice != null && latestPrice !== marketSub.lastTickPrice) {
    marketSub.lastTickPrice = latestPrice;
    void deps.evaluateRealtimeExits(contractId, latestPrice);
  }
}
