import type { OrderSide } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { DeploymentState } from "./engine";

/** The two engine members a fill path latches through. */
export interface EntryLatchDeps {
  stateFor: (deploymentId: string) => DeploymentState | undefined;
  markEnteredThisSession: (deploymentId: string, sessionKey: string, side: OrderSide) => void;
}

/**
 * Latch the one-per-side cap for a filled entry. Every fill path calls this
 * on the fill, never on the signal, so a rejected or cancelled order caps
 * nothing.
 *
 * The in-memory stash is preferred while it is this trade's; the row's
 * stored key covers an entry that was pending across a restart, when the
 * new process has no stash and no `activeTradeId` for it (A92). Another
 * trade's stash is never read: it may carry a different session's key.
 * Marking twice is harmless — the latch is a set.
 */
export function latchFilledEntry(deps: EntryLatchDeps, trade: StrategyTrade): void {
  const state = deps.stateFor(trade.deploymentId);
  const ownsStash = state?.activeTradeId === trade.id;
  const key = (ownsStash ? state.pendingEntrySessionKey : null) ?? trade.sessionKey;
  if (key != null) deps.markEnteredThisSession(trade.deploymentId, key, trade.side as OrderSide);
  if (ownsStash) state.pendingEntrySessionKey = null;
}
