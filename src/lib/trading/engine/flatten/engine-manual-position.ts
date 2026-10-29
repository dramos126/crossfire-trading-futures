// D-2 enforcement — the engine force-closes positions it did not open.
// P4 of docs/proposals/position-lifecycle.md.
//
// This is the only sweep in the engine that closes a position the *operator*
// opened by hand, so every predicate below is written to fail toward leaving
// it alone. The rule, in the order the code asks it:
//
//   1. **Claim.** An instrument is claimed while a deployment on that account
//      is `Active`, its group is enabled, and the wall clock is inside one of
//      its session windows. That single predicate is D-2's carve-out *and*
//      D-11's expiry — "opened while nothing was active on that instrument"
//      needs no durable opened-at record, because a position opened while the
//      instrument was claimed would already have been closed on the pass
//      after it appeared. See the Decisions entry in engine.md.
//   2. **Instrument is the product root, not the contract.** An MGC
//      deployment claims an MGC hand position in any month —
//      `productRootFromContractId`, and a root that will not parse is never
//      claimed and is logged.
//   3. **Attribution, not identity.** Futures positions net, so "did the
//      engine open this" is D-6's signed arithmetic against what the engine
//      *intended*: the sum of its own trade rows on that contract.
//   4. **Act only on a wholly manual contract** — `excess` with an expected
//      of exactly flat. A `shortfall` is "the arithmetic cannot say" and is
//      never actionable; an excess entangled with an engine position needs a
//      partial-reduce primitive that does not exist. Both are reported.
//
// The close goes through `placeExitOrder`, not around it. The two latch
// bypasses that exist (`flattenNakedPosition`, `flatten-all`) are last-resort
// paths and this is not one — it is policy, and it should be refusable by an
// exit already on the wire. `EXIT_IN_FLIGHT` therefore means "already
// happening, fine", exactly as it does for the session and closing guards.
//
// A stateful controller for the same reason `engine-watchdog.ts` is one: the
// report anchors below are written by this sweep and read nowhere else.
//
// The post-flatten cooldown is the exception and does **not** live here; see
// `engine-flatten-cooldown.ts`. This sweep still consults it and still stamps
// it, but **not for the reason this header used to give.** It named the
// naked-position watchdog reaching the same hand position "inside
// `collectManagedContractIds`" — false by construction since D-16, which
// scoped that set to contracts carrying a reconcilable trade row while this
// sweep acts only where the same query says there is none. The two are
// complementary and can no longer reach one `(account, contract)`. The wiring
// stays because the shared state is per-actor rather than per-pair, and this
// is the one actor nothing else can stamp for — so removing the consultation
// here would be invisible from above, which is exactly how the original gap
// survived.

import type { ExitReasonCode } from "@/lib/logging/exit-reasons";
import type { Broker } from "../../broker-access/broker";
import type { Contract, Position } from "@/lib/brokers/types";
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { Deployment, TickerSymbol } from "@/lib/trading/domain";
import type { CommonParams, OpenPosition, StrategyModule } from "../../strategy-types";
import type { LogSubject } from "../engine";
import { ENGINE_SCOPE, type LogCategory, type Severity } from "@/lib/logging/vocabulary";
import type { FlattenCooldown } from "../engine-flatten-cooldown";
import { entrySideFromSigned, signedSize, signedSizeForEntrySide } from "@/lib/brokers/types";
import { attributePosition, describePositionAttribution } from "../realtime/engine-position-attribution";
import { readPositionsThrough, recordPositions } from "../realtime/account-view";
import { productRootFromContractId } from "../../broker-access/contract-pairing";
import { executionContractId } from "../../broker-access/contract-resolver";
import {
  collectSessionWindows,
  isInAnySessionWindow,
  minutesInTradingTz,
  parseHHMM,
  claimableWindows,
} from "../../session/session";
import { earlyCloseFor, isInEarlyCloseHalt } from "../../session/exchange-calendar";
import { etDateKey } from "../../session/session-utils";
import type { SessionWindow } from "../../strategy-types";
import { defaultParamValues, migrateLegacyParamOverrides } from "../../strategy-types";
import { getStrategy } from "../../strategies";
import { EntryExitCode } from "../../orders/entry-exit-codes";

/**
 * Sweep cadence. Matches `SESSION_END_GUARD_INTERVAL_MS`,
 * `CLOSING_GUARD_INTERVAL_MS` and `REST_TICK_MS`, so this adds no new timing
 * regime — and it is the cadence D-11's second prompt implicitly promises,
 * since "will be closed at 09:30" has to mean *at* 09:30 rather than at the
 * next bar close.
 *
 * The common pass makes **no broker call at all**: an account with no claimed
 * instrument — which is every account outside its session windows, and every
 * account whose deployments are all paused — returns before the position
 * lookup.
 */
export const MANUAL_POSITION_GUARD_INTERVAL_MS = 15_000;

/**
 * How often a persistent failure is re-reported per (account, contract).
 * Same shape and the same reason as the session and closing guards': a broker
 * outage means this retries and fails every interval, and four lines a minute
 * per stranded contract drowns the log that has to carry the incident.
 */
export const MANUAL_POSITION_GUARD_REPORT_MS = 300_000;

/** Exit reason stamped on the close. Distinct from `deployment_close` and
 *  `time_window_close` because the *operator* needs to tell "the engine
 *  closed my hand trade" apart from "the engine closed its own".
 *
 *  **It is unreachable as a rendered label today and no longer a trap if it
 *  becomes reachable.** This sweep acts on positions the engine holds *no*
 *  trade row for, so it passes `activeTradeId: null` below and
 *  `placeExitOrder` skips `attachPendingExit` — the reason exists for the log
 *  line and for the exit dispatch's own bookkeeping. It used to have no
 *  `formatExitReason` arm, so a future caller passing a trade id would have
 *  dropped the row onto the residual label and had it swept by the relabeller
 *  forever. It now carries a label, an Activity phrasing and a chip because
 *  it is in the one exit-reason table, and the type on this constant is what
 *  guarantees that. */
export const MANUAL_POSITION_EXIT_REASON: ExitReasonCode = "manual_position_close";

/**
 * Engine-internal surface this sweep calls back into. Mirrors
 * `SessionGuardDeps` / `ClosingGuardDeps` — bound callbacks rather than
 * flipped access modifiers.
 *
 * **There is deliberately no `stateFor` and no DB-open-trade union.** Both
 * sibling guards have one so their lifetime keys off whether a position is
 * open rather than engine run state; this one must key off the *claim*, and a
 * claim is something only a running engine holds. `stop()` empties
 * `realtimeDeployments`, which is exactly the right answer here: a stopped
 * engine claims no instrument and must not flatten an operator's position.
 */
export interface ManualPositionGuardDeps {
  log(
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ): void;
  /** A line that names a vocabulary event; the registry decides its
   *  severity and category, and whether it escalates. See
   *  `TradingEngine.logEvent`. */
  logEvent(event: string, deploymentId: string, message: string, subject?: LogSubject): void;
  /** Current realtime deployment set, read at call time — a sweep must see
   *  deployments added or removed since the interval was armed. */
  realtimeDeployments(): Deployment[];
  /** Entry-eval gate: `Active` and group-enabled. D-11 scopes the claim to a
   *  deployment the engine is *trading*, so this is the entry predicate and
   *  not `isLegInExitLoop` — a `Pausing` leg is on its way out and claims
   *  nothing. */
  isLegEngineEnabled(deployment: Deployment): boolean;
  isAccountRegistered(accountId: number): boolean;
  brokerForAccount(accountId: number): Broker;
  resolveContract(ticker: TickerSymbol, accountId: number): Promise<Contract>;
  /** `pending_entry` / `open` / `pending_exit` rows for the account — the
   *  engine's own intent, and the operand D-6's second correction demands.
   *  See `expectedByContract`. */
  reconcilableTrades(accountId: number): StrategyTrade[];
  /** True while `contractLocks` holds `(accountId, contractId)`. Acquired in
   *  `placeEntryOrder` **before** the `placeOrder` call, so it covers the one
   *  window a trade row does not: an entry submitted but not yet filled or
   *  rowed. Read synchronously immediately before the dispatch. */
  isContractLocked(accountId: number, contractId: string): boolean;
  /** The engine's, bound with `intent: "unmanaged_position"` — this sweep
   *  is the only caller that declares one. The intent is read by
   *  `verifyExitClean` and by nothing else; it changes what the post-exit
   *  line *says*, never what the exit does. */
  placeExitOrder(
    strategy: StrategyModule,
    deployment: Deployment,
    contract: Contract,
    position: OpenPosition,
    activeTradeId: number | null,
    reason: string,
  ): Promise<void>;
  /** Post-flatten cooldown, shared with the naked-position watchdog. Not
   *  owned here, because the watchdog is the other actor that can submit a
   *  market order against this same position — see the module header. */
  flattenCooldown: FlattenCooldown;
}

/**
 * What D-11's second prompt has to say, computed from the same rule the
 * sweep enforces.
 *
 * `whenNy` is the point of it. *"Your 2 MGC will be closed at 09:30"* and
 * *"…will be closed immediately"* read completely differently to someone
 * holding a position, and a prompt that states only *that* it will happen
 * produces the failure D-11 names: the operator activates at 08:00, sees
 * nothing happen, concludes they are fine, and is flattened ninety minutes
 * later while not watching.
 */
export interface ManualPositionClaimPreview {
  /** Product root the activation would claim, or null when the contract
   *  cannot be resolved or read — in which case `positions` is empty and the
   *  caller must not imply that nothing will be closed. */
  root: string | null;
  /** True when the claim is live right now, so the close is immediate. */
  inWindow: boolean;
  /** `HH:MM` in the trading timezone when the claim next becomes live, or
   *  null when the deployment has no session window at all. Meaningful only
   *  while `inWindow` is false. */
  whenNy: string | null;
  /** Hand positions the activation would close. Empty is the common case and
   *  means the caller shows the rule prompt alone. */
  positions: { contractId: string; side: "LONG" | "SHORT"; size: number }[];
}

/** One claimed product root on one account, and the deployment whose identity
 *  the close is placed under. */
interface InstrumentClaim {
  root: string;
  deployment: Deployment;
  /** The claiming deployment's own resolved contract. Different months of one
   *  product share tick parameters, which is what lets this stand in for the
   *  hand-held month — see `contractForClaimedMonth`. */
  contract: Contract;
}

export class ManualPositionGuard {
  /** False from `disarm()` until the next `arm()`.
   *
   *  `clearInterval` disarms the *next* pass; it does nothing to one already
   *  parked on `searchOpenPositions`, which captured `realtimeDeployments`
   *  before `stop()` emptied it and would otherwise complete and submit
   *  against an operator's position on a stopped engine. This is what makes
   *  "a stopped engine claims no instrument" true rather than nearly true. */
  private armed = true;
  /** First-failure anchor per `${accountId}:${contractId}`, epoch ms. */
  private failureSince = new Map<string, number>();
  /** Last time anything was reported for that key, epoch ms. Shared by the
   *  failure arm and the three refusal arms — all four are per-pass repeats
   *  of a standing condition. */
  private reportedAt = new Map<string, number>();

  constructor(private readonly deps: ManualPositionGuardDeps) {}

  /** Called from `startManualPositionGuard`, before the interval is set. */
  arm(): void {
    this.armed = true;
  }

  /** Called from `stop()`, alongside `clearInterval`. Both are needed: the
   *  interval stops the next pass, this stops the one in flight. */
  disarm(): void {
    this.armed = false;
  }

  /**
   * One clock-driven pass.
   *
   * Ordering is load-bearing in the same way the session guard's is, arrived
   * at from the other side: every `await` happens *before* the synchronous
   * lock re-check that gates the dispatch, so nothing can be parked between
   * "the engine claims nothing on this contract" and the close that assumes
   * it. `armed` is re-read at the same points and for the same reason.
   */
  async runManualPositionGuard(): Promise<void> {
    if (!this.armed) return;
    const claimsByAccount = await this.collectClaims();
    if (claimsByAccount.size === 0) return;

    for (const [accountId, claims] of claimsByAccount) {
      if (!this.armed) return;
      let positions: Position[];
      // Before the fetch: the account view drops a read asked before a newer write.
      const askedAt = Date.now();
      try {
        positions = await this.deps.brokerForAccount(accountId).searchOpenPositions(accountId);
      } catch (err) {
        this.report(
          `${accountId}:*`,
          accountId,
          ENGINE_SCOPE,
          "manual_position_lookup_failed",
          `Manual-position sweep: position lookup failed for account ${accountId}: ${message(err)}`,
        );
        continue;
      }
      recordPositions(accountId, positions, "sweep", askedAt);

      const expected = this.expectedByContract(accountId);
      if (expected === null) continue;
      // The account answered on both reads, so whatever outage the `:*` arms
      // were reporting is over. Without this the anchor stands for the life
      // of the process and an unrelated failure days later renders
      // "Standing for 259200s".
      this.clear(`${accountId}:*`);

      for (const pos of positions) {
        if (pos.size <= 0) continue;

        const root = productRootFromContractId(pos.contractId);
        if (root === null) {
          // "Cannot tell" must never become "flatten it". Loud, because the
          // leave is the audible half of D-2 and the claim would not be.
          this.report(
            `${accountId}:${pos.contractId}`,
            accountId,
            ENGINE_SCOPE,
            "manual_position_unreadable_contract",
            `Cannot read a product root from contract "${pos.contractId}" on account ${accountId}, so this position is not claimed and will not be closed. ` +
              `If it is a hand position on an instrument the engine trades, close it manually.`,
            pos.contractId,
          );
          continue;
        }

        const claim = claims.get(root);
        if (!claim) continue; // Carve-out: nothing Active and in-window on this instrument.

        const key = `${accountId}:${pos.contractId}`;
        const attribution = attributePosition({
          expectedSigned: expected.get(pos.contractId) ?? 0,
          actualSigned: signedSize(pos),
        });

        if (attribution.kind === "aligned") {
          this.clear(key);
          continue;
        }
        if (attribution.kind === "shortfall") {
          // Never actionable. A partial entry fill and an operator reduction
          // are the same number, and the tiebreaker is the fills' customTags.
          this.report(
            key,
            accountId,
            claim.deployment.id,
            "manual_position_shortfall",
            `Not acting on ${pos.contractId}: ${describePositionAttribution(attribution)}.`,
            pos.contractId,
          );
          continue;
        }
        if (attribution.expectedSigned !== 0) {
          // Excess netted into a position the engine *does* hold. Reducing it
          // means an order sized below the broker's position, which no engine
          // path can place — `placeExitOrder` takes its size from the broker
          // by design. Reported, not acted on; see engine.md.
          this.report(
            key,
            accountId,
            claim.deployment.id,
            "manual_position_entangled",
            `Manual size on ${pos.contractId} is netted into an engine position — ${describePositionAttribution(attribution)}. ` +
              `Not auto-corrected: closing only the excess needs a reducing order the engine has no path for.`,
            pos.contractId,
          );
          continue;
        }

        // Shared with the naked-position watchdog, which reaches this same
        // position by the opposite predicate and bypasses the exit latch —
        // see engine-flatten-cooldown.ts.
        if (this.deps.flattenCooldown.active(accountId, pos.contractId)) continue;

        await this.flattenManualPosition(claim, pos, attribution.actualSigned, key);
      }
    }
  }

  /**
   * Claimed roots per account: every deployment the engine is trading right
   * now, keyed by the product root of its own resolved contract.
   *
   * The session gate is what makes this D-11 rather than D-2 as first
   * written. Activating an MGC deployment at 08:00 whose window opens at
   * 09:30 leaves a hand-held MGC position untouched until 09:30 — the engine
   * claims an instrument while it is *trading* it, not while it is merely
   * configured.
   *
   * A deployment whose contract will not resolve claims nothing this pass.
   * That is the fail-toward-leaving-it-alone direction, and it is why the
   * resolve failure is not reported here: the sweep is not the thing that
   * needs the contract, and every other engine path on this deployment
   * already reports it.
   */
  private async collectClaims(): Promise<Map<number, Map<string, InstrumentClaim>>> {
    const byAccount = new Map<number, Map<string, InstrumentClaim>>();
    const now = new Date();

    for (const deployment of this.deps.realtimeDeployments()) {
      if (!this.deps.isLegEngineEnabled(deployment)) continue;
      if (!this.deps.isAccountRegistered(deployment.accountId)) continue;
      if (!this.isInSession(deployment, now)) continue;

      let contract: Contract;
      try {
        contract = await this.deps.resolveContract(deployment.ticker, deployment.accountId);
      } catch {
        continue;
      }
      const root = productRootFromContractId(executionContractId(contract));
      if (root === null) continue;

      let claims = byAccount.get(deployment.accountId);
      if (!claims) {
        claims = new Map<string, InstrumentClaim>();
        byAccount.set(deployment.accountId, claims);
      }
      if (!claims.has(root)) claims.set(root, { root, deployment, contract });
    }

    return byAccount;
  }

  private isInSession(deployment: Deployment, now: Date): boolean {
    const windows = sessionWindowsFor(deployment.strategyKey, deployment.paramValues, deployment.id);
    if (windows === null) return false;
    if (!claimableWindows(windows)) {
      this.report(
        `${deployment.accountId}:session`,
        deployment.accountId,
        deployment.id,
        "manual_position_window_unreadable",
        `Deployment ${deployment.id} has an unreadable session window — its instrument is not claimed. ` +
          `Fix the session times; until then a hand position on this product is left alone.`,
      );
      return false;
    }
    // Readable again — drop the anchor so a later, unrelated failure does not
    // inherit this one's age.
    this.clear(`${deployment.accountId}:session`);
    return isInAnySessionWindow(now, windows);
  }

  /**
   * D-11's prompt 2, answered by the rule rather than beside it.
   *
   * Deliberately the *same* traversal as one pass of the sweep, narrowed to
   * one account and one instrument: same root extraction, same expected-flat
   * operand, same "positions the engine does not claim". A preview computed
   * from a second, parallel reading of the rule is a preview that can be
   * wrong in exactly the way that matters — telling the operator nothing will
   * be closed and then closing something.
   *
   * The session gate is *not* applied to the position filter. The prompt's
   * job is to say what will be closed and **when**, so a preflight run at
   * 08:00 against a 09:30 window must list the positions and report the time,
   * not report nothing.
   *
   * `live` is the activation prompt's ask; without it the board strip's.
   */
  async previewClaim(input: {
    accountId: number;
    ticker: TickerSymbol;
    strategyKey: string;
    paramValues: Deployment["paramValues"];
    now?: Date;
    live?: boolean;
  }): Promise<ManualPositionClaimPreview> {
    const now = input.now ?? new Date();
    // Same narrowing as the sweep, for the same reason and so the two agree:
    // an unreadable window is one this guard never claims inside, and a
    // deployment with no windows at all never claims either. Promising a close
    // the sweep will not make is worse than promising nothing — prompt 2 is
    // the non-suppressible one.
    const raw = sessionWindowsFor(input.strategyKey, input.paramValues, "preflight") ?? [];
    const windows = claimableWindows(raw) ? raw : [];
    const claims = windows.length > 0;
    const inWindow = claims && isInAnySessionWindow(now, windows);
    const whenNy = !claims || inWindow ? null : nextWindowStartNy(now, windows);

    // A deployment that never claims has nothing to preview. Returning
    // positions here would render "will close it when the session window
    // opens" for a window that does not exist or cannot be read.
    if (!claims) return { root: null, inWindow: false, whenNy: null, positions: [] };

    let root: string | null = null;
    try {
      const contract = await this.deps.resolveContract(input.ticker, input.accountId);
      root = productRootFromContractId(executionContractId(contract));
    } catch (err) {
      // Same as the read below: the live ask must not answer "nothing" (A117).
      if (input.live) throw err;
      return { root: null, inWindow, whenNy, positions: [] };
    }
    if (root === null) return { root: null, inWindow, whenNy, positions: [] };

    // The strip displays only, so it reads the account view: a sweep's read
    // under 60 s old costs the broker nothing, and an older one is one live
    // read shared by every probe on the account (A115). The activation prompt
    // reads live: a hand position opened since the last sweep is absent from
    // a fresh view, and prompt 2 is the only warning before the pass above
    // closes it. The pass itself never reads the view — it acts.
    // A117: on the live ask an unanswerable read rejects. An empty list is
    // what the prompt reads as "nothing to close", so answering one for a
    // failed read silenced prompt 2 before a pass that could then close the
    // position. The preflight route turns the rejection into a non-OK
    // response, which the client already treats as "could not answer".
    const accountId = input.accountId;
    const search = () => this.deps.brokerForAccount(accountId).searchOpenPositions(accountId);
    let positions: readonly Position[];
    if (input.live) {
      const askedAt = Date.now();
      positions = await search();
      recordPositions(accountId, positions, "route", askedAt);
    } else {
      try {
        positions = (await readPositionsThrough(accountId, search, "route")).items;
      } catch {
        return { root, inWindow, whenNy, positions: [] };
      }
    }
    const expected = this.expectedByContract(input.accountId);
    if (expected === null) {
      if (input.live) throw new Error(`previewClaim: trade rows unreadable for account ${accountId}`);
      return { root, inWindow, whenNy, positions: [] };
    }

    const claimed: ManualPositionClaimPreview["positions"] = [];
    for (const pos of positions) {
      if (pos.size <= 0) continue;
      if (productRootFromContractId(pos.contractId) !== root) continue;
      if ((expected.get(pos.contractId) ?? 0) !== 0) continue;
      const signed = signedSize(pos);
      if (signed === 0) continue;
      claimed.push({ contractId: pos.contractId, side: signed > 0 ? "LONG" : "SHORT", size: pos.size });
    }
    return { root, inWindow, whenNy, positions: claimed };
  }

  /**
   * The engine's *intent* per contract on this account, signed.
   *
   * D-6's second correction is the whole of this function. P2's operand was
   * `DeploymentState.position.size`, which self-describes as a mirror of the
   * broker's reported size and is resynced on magnitude by
   * `handleUserPositionEvent` — so a same-direction manual excess silently
   * heals into `aligned`, and that is precisely the arm P4 exists to act on.
   * Worse for an actioning phase: a `pending_entry` row has no
   * `DeploymentState.position` at all, so an entry that filled 1 of 2 would
   * read as expected-flat and be force-closed as the operator's. The trade
   * row knows the size it intended, through every one of those states.
   *
   * Summed rather than taken singly because `contractLocks` guarantees one
   * deployment per (account, contract) at a time, not one row: a
   * `pending_exit` row and its replacement can briefly coexist, and reading
   * either alone understates the claim.
   */
  private expectedByContract(accountId: number): Map<string, number> | null {
    const byContract = new Map<string, number>();
    let trades: StrategyTrade[];
    try {
      trades = this.deps.reconcilableTrades(accountId);
    } catch (err) {
      // `null`, never an empty map. The sibling guards read a DB failure as
      // best-effort and carry on with what they have; here "what we have" is
      // an expectation of flat for every contract, which reads the engine's
      // own positions as wholly manual and flattens them. Skip the account.
      this.report(
        `${accountId}:*`,
        accountId,
        ENGINE_SCOPE,
        "manual_position_rows_unreadable",
        `Manual-position sweep: trade-row read failed for account ${accountId}: ${message(err)} — skipping the account this pass rather than reading its engine positions as manual.`,
      );
      return null;
    }
    // Summed, not last-wins, because `contractLocks` guarantees one *deployment*
    // per (account, contract) — not one row. A `pending_exit` and its
    // replacement `pending_entry` coexist briefly, and reading either alone
    // understates the claim.
    //
    // **The summing has one degenerate case, and the contract lock is the only
    // thing standing in front of it.** Two *opposing* rows on one contract sum
    // to zero, which reads as expected-flat — the wholly-manual arm — and the
    // engine would force-close its own position with `activeTradeId: null`,
    // cancelling its own brackets on the way. That is unreachable today only
    // because `acquireContractLock` is taken before `placeOrder`, released at
    // the three terminal reconcile sites, and rebuilt at boot from this same
    // `getReconcilableTrades()` query — so lock-held and row-exists are the
    // same set, and the synchronous lock re-check before dispatch refuses it.
    // **If that invariant is ever weakened, this sum becomes a live hazard.**
    for (const trade of trades) {
      const prior = byContract.get(trade.contractId) ?? 0;
      byContract.set(trade.contractId, prior + signedSizeForEntrySide(trade.side, trade.size));
    }
    return byContract;
  }

  /**
   * Submit the close.
   *
   * `activeTradeId` is null and that is not an omission: there is no engine
   * trade row on this contract, which is what `expectedSigned === 0` means.
   * It also makes `cancelTrackedBrackets` take its Stage 2 arm — cancel every
   * working order on this contract that is not in the deployment's pre-entry
   * snapshot — which is D-2's "cancel its non-engine working orders", and is
   * safe *because* the contract is wholly manual. On any contract the engine
   * does hold a row for, that same arm would cancel the engine's own
   * brackets; the expected-flat gate is what keeps the two apart.
   */
  private async flattenManualPosition(
    claim: InstrumentClaim,
    pos: Position,
    actualSigned: number,
    key: string,
  ): Promise<void> {
    const { deployment } = claim;
    const strategy = getStrategy(deployment.strategyKey);
    if (!strategy) {
      this.report(
        key,
        deployment.accountId,
        deployment.id,
        "manual_position_strategy_missing",
        `Cannot close manual position on ${pos.contractId}: strategy ${deployment.strategyKey} is not registered.`,
        pos.contractId,
      );
      return;
    }

    const side = entrySideFromSigned(actualSigned);
    if (side === null) return;

    // Re-read at the point of use. Everything above this line has awaited;
    // `placeEntryOrder` takes the lock synchronously before its own
    // `placeOrder`, so a lock appearing during those awaits means the engine
    // is entering on this very contract and the position is about to stop
    // being manual.
    if (this.deps.isContractLocked(deployment.accountId, pos.contractId)) {
      this.clear(key);
      return;
    }
    // Same rule applied to the claim itself: `stop()` may have landed during
    // any of those awaits, and a stopped engine claims no instrument.
    if (!this.armed) return;

    // **The authority is the declared window; the submission is not.** The
    // claim over the operator's position stays on `isInSession`'s nominal
    // window — narrowing that would change what the claim means, and it is
    // not this predicate's to change. But the action here is a market order,
    // and no market order fills into a closed exchange: on an exchange early
    // close this would otherwise put bugs.md A63 on the manual path, on the
    // same nine or ten dates a year. So the close is *held*, not dropped.
    // Nothing is cleared, the claim stays live, and the next pass after the
    // 18:00 reopen takes it. A fresh clock rather than the sweep's: the pass
    // has awaited two broker round trips since.
    const now = new Date();
    if (isInEarlyCloseHalt(now)) {
      this.report(
        key,
        deployment.accountId,
        deployment.id,
        "manual_position_exchange_closed",
        `Not closing the manual position on ${pos.contractId} yet: the exchange closes early at ` +
          `${earlyCloseFor(etDateKey(now)) ?? "an earlier time"} NY today, so a market order would not fill. ` +
          `The position is still open — close it by hand if it must not be carried past the reopen.`,
        pos.contractId,
      );
      return;
    }

    const contract = contractForClaimedMonth(claim.contract, pos.contractId);
    const position: OpenPosition = {
      side,
      entryPrice: pos.averagePrice,
      entryTimestamp: pos.creationTimestamp,
      entryFilledAt: pos.creationTimestamp,
      barsSinceEntry: 0,
      size: pos.size,
      slTicks: null,
    };

    // Logged *after* the submit returns, not before it. This is the one line
    // an operator greps for after finding a hand position gone, so it must not
    // claim a close that did not happen — and three arms below reach here
    // having placed nothing: `EXIT_IN_FLIGHT`, `placeExitOrder`'s own
    // already-flat skip, and `EXIT_FLAT_MISMATCH`. That last one is *not* a
    // failure here, and D-2 is the one caller for which it is not: the
    // mismatch discriminator is deployment-scoped, while this sweep's target
    // contract is by construction one the deployment holds no row for. So an
    // open row on the deployment's *own* contract — the healthy, expected
    // state — is exactly what makes the discriminator fire, on a question this
    // sweep never asked. Announcing first would put a false force-close in
    // `/logs` every 15s while the claiming deployment's own exit sits on the
    // wire.
    this.deps.flattenCooldown.note(deployment.accountId, pos.contractId, "d2");
    try {
      await this.deps.placeExitOrder(
        strategy,
        deployment,
        contract,
        position,
        null,
        MANUAL_POSITION_EXIT_REASON,
      );
      this.deps.logEvent(
        "unmanaged_position_closed",
        deployment.id,
        `Force-closed a position the engine did not open: account ${deployment.accountId}, ${pos.contractId}, ` +
          `${side === 0 ? "LONG" : "SHORT"} ${pos.size}. Claimed by ${deployment.ticker} (root ${claim.root}), which is Active and inside its session window.`,
        { accountId: deployment.accountId, contractId: pos.contractId },
      );
      this.clear(key);
    } catch (err) {
      if (err instanceof Error && err.message === EntryExitCode.EXIT_IN_FLIGHT) {
        // The claiming deployment's own exit is on the wire. Not a failure —
        // and not this position either, so drop the cooldown so the next pass
        // reconsiders rather than waiting one out for a close it never made.
        // `release` drops only a stamp this sweep wrote: nothing here says
        // anything about a watchdog market order already on the book.
        this.deps.flattenCooldown.release(deployment.accountId, pos.contractId, "d2");
        this.clear(key);
        return;
      }
      if (err instanceof Error && err.message === EntryExitCode.EXIT_FLAT_MISMATCH) {
        // The broker went flat on this contract during the cancel round-trip,
        // and the row the discriminator found is the deployment's own on
        // another contract — healthy, and none of this sweep's business.
        // Nothing was submitted and nothing failed, so this is quiet and the
        // cooldown goes back for the same reason `EXIT_IN_FLIGHT` returns it:
        // no market order of ours is on the book to guard.
        this.deps.flattenCooldown.release(deployment.accountId, pos.contractId, "d2");
        this.clear(key);
        return;
      }
      this.deps.flattenCooldown.release(deployment.accountId, pos.contractId, "d2");
      this.report(
        key,
        deployment.accountId,
        deployment.id,
        "manual_position_close_failed",
        `Could not close the manual position on ${pos.contractId}: ${message(err)}.`,
        pos.contractId,
      );
    }
  }

  /**
   * Escalate on the first occurrence, then throttle per key. The suffix says
   * how long the condition has stood, because an operator reading `/logs`
   * needs "for 12 minutes", not "again".
   *
   * **Every arm names an event, and the event is what decides severity.**
   * One of them — the close that failed — is `error` and is the only
   * condition here an operator has to act on, so it is the only one the
   * ladder sends to Discord. The rest are `warn`: states this sweep refuses
   * to act on (a shortfall, an entangled excess, an unparseable root); they
   * are findings, not alarms. Which is which lives in the vocabulary, not
   * here, so a caller cannot downgrade the alarm by passing a quieter level.
   */
  private report(
    key: string,
    accountId: number,
    deploymentId: string,
    event: string,
    detail: string,
    contractId: string | null = null,
  ): void {
    const nowMs = Date.now();
    const since = this.failureSince.get(key) ?? nowMs;
    this.failureSince.set(key, since);
    const last = this.reportedAt.get(key);
    if (last != null && nowMs - last < MANUAL_POSITION_GUARD_REPORT_MS) return;
    this.reportedAt.set(key, nowMs);
    const standing = Math.round((nowMs - since) / 1000);
    const message = standing > 0
      ? `${detail} Standing for ${standing}s; re-checked every ${Math.round(MANUAL_POSITION_GUARD_INTERVAL_MS / 1000)}s. (account ${accountId})`
      : `${detail} Re-checked every ${Math.round(MANUAL_POSITION_GUARD_INTERVAL_MS / 1000)}s. (account ${accountId})`;
    this.deps.logEvent(event, deploymentId, message, { accountId, contractId });
  }

  private clear(key: string): void {
    this.failureSince.delete(key);
    this.reportedAt.delete(key);
  }
}

/**
 * The claiming deployment's contract, re-pointed at the month the hand
 * position is actually on.
 *
 * D-2 claims a root in *any* month, so the position can sit on a contract no
 * deployment resolves to, and there is no broker-agnostic "resolve this
 * contract id" on the `Broker` seam to fetch it with. Only two fields are
 * load-bearing downstream — `executionContractId(contract)` picks the
 * contract to trade, and `tickSize` rides along on the order — and tick
 * parameters are a property of the *product*, not the expiry. That is the
 * same assumption `BrokerAwareContractResolver` already ships on when it
 * borrows Topstep's tick parameters for the paired Tradovate contract.
 *
 * Both id fields are written so the object cannot half-answer: `id` alone
 * would leave a Tradovate-routed contract's `executionContractId` pointing at
 * the front month while `id` named another.
 */
/**
 * The leg's session windows, or `null` when its strategy is not registered —
 * which is a different answer from "no windows" and must not collapse into
 * one: an unregistered strategy claims nothing, while a playbook whose
 * `config.session` is fully covered by the deployment's pauses genuinely has
 * no window.
 */
function sessionWindowsFor(
  strategyKey: string,
  paramValues: Deployment["paramValues"],
  deploymentId: string,
): SessionWindow[] | null {
  const strategy = getStrategy(strategyKey);
  if (!strategy) return null;
  const params = {
    ...defaultParamValues(strategy.params),
    ...migrateLegacyParamOverrides(strategyKey, paramValues, { deploymentId }),
  } as CommonParams;
  return collectSessionWindows(strategy.config.session, params);
}

/**
 * The next window start, as `HH:MM` in the trading timezone.
 *
 * Wall-clock rather than an instant, deliberately. Session windows *are*
 * `HH:MM` — that is the whole of what the operator configured — so resolving
 * one into a timestamp would invent a date, and the two disagree across a DST
 * boundary in exactly the direction that makes the prompt wrong.
 */
export function nextWindowStartNy(now: Date, windows: ReadonlyArray<SessionWindow>): string | null {
  const nowMin = minutesInTradingTz(now);
  let best: { at: string; delta: number } | null = null;
  for (const w of windows) {
    const start = parseHHMM(w.start);
    if (start === null) continue;
    const delta = (start - nowMin + 1440) % 1440;
    if (best === null || delta < best.delta) best = { at: w.start, delta };
  }
  return best?.at ?? null;
}

export function contractForClaimedMonth(base: Contract, contractId: string): Contract {
  return { ...base, id: contractId, executionContractId: contractId, name: contractId };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
