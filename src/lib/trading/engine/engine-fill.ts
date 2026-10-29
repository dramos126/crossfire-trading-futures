// Closing-fill classification for the engine. The discriminator is
// per-broker and selected by `capabilities.fillCarriesPnl` — a broker
// that stamps realized PnL on closing fills keys on `profitAndLoss !=
// null`, one that does not keys on the orderId matching the trade's
// bracket/exit ids. A third broker that carries neither signal needs its
// own arm here and nowhere else.

import type { BrokerPlugin } from "@/lib/brokers/plugin";
import { BrokerKind } from "@/lib/db/account-brokers";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { TradeFill } from "@/lib/brokers/types";

/**
 * Engine-internal surface used by {@link isClosingFill}. The classifier
 * only needs the broker plugin a kind resolves to, so it can read
 * `capabilities.fillCarriesPnl` and fork between the PnL-based
 * discriminator and the orderId-against-bracket one.
 */
export interface IsClosingFillDeps {
  pluginFor: (kind: BrokerKind) => BrokerPlugin;
}

/**
 * Per-broker closing-fill classifier. Shared clauses are broker-agnostic;
 * the discriminator clause is selected by `capabilities.fillCarriesPnl`.
 * Per docs/proposals/userhub-trade-subscription.md §Layer 1 — buffer drain.
 *
 * `fillCarriesPnl` (Topstep): `f.profitAndLoss !== null AND
 *   f.orderId !== entryOrderId`.
 * Otherwise (Tradovate): orderId-against-bracket discriminator per Gate B
 *   probe candidate #1. `f.orderId in {tpOrderId, slOrderId, exitOrderId}
 *   OR f.orderId !== entryOrderId`. The timestamp lower-bound is
 *   already enforced by the shared clauses above; restating it here
 *   would be redundant. Tradovate `fill` entities never carry `pnl`
 *   (Gate B finding) so the PnL discriminator is unavailable.
 *   Source of `tpOrderId` / `slOrderId` / `exitOrderId` is the trade
 *   row itself — `setBracketOrderIds` (commit 9315a19) stamps the
 *   bracket ids onto the row from `tradovate_order_map` at entry-fill
 *   time, so the classifier reads them directly without a fresh
 *   DB query.
 */
export function isClosingFill(
  deps: IsClosingFillDeps,
  brokerKind: BrokerKind,
  fill: TradeFill,
  trade: StrategyTrade,
): boolean {
  if (fill.voided) return false;
  if (trade.entryFilledAt == null) return false;
  if (new Date(fill.creationTimestamp).getTime() < new Date(trade.entryFilledAt).getTime()) return false;
  if (fill.contractId !== trade.contractId) return false;
  const closingSide: 0 | 1 = trade.side === 0 ? 1 : 0;
  if (fill.side !== closingSide) return false;

  if (deps.pluginFor(brokerKind).capabilities.fillCarriesPnl) {
    if (fill.profitAndLoss == null) return false;
    if (trade.entryOrderId != null && fill.orderId === trade.entryOrderId) return false;
    return true;
  }
  // orderId-against-bracket discriminator. The bracket-id
  // arm catches TP/SL fills cleanly (probe scenarios 1 + 2). The
  // entry-orderId-distinct arm catches manual-close fills issued
  // either by the engine's exit-at-market path or the operator from
  // the Tradovate webapp (probe scenario 3) — both arrive with an
  // orderId distinct from the entry's.
  if (
    (trade.tpOrderId != null && fill.orderId === trade.tpOrderId) ||
    (trade.slOrderId != null && fill.orderId === trade.slOrderId) ||
    (trade.exitOrderId != null && fill.orderId === trade.exitOrderId)
  ) {
    return true;
  }
  if (trade.entryOrderId != null && fill.orderId !== trade.entryOrderId) {
    return true;
  }
  return false;
}
