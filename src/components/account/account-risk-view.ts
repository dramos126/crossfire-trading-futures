/**
 * What an account's risk row *says*, read once for every surface that says it.
 *
 * Ninth pure module on the `deployment-status.ts` / `trade-markers.ts` /
 * `board-model.ts` / `board-view.ts` pattern, and it exists because two
 * surfaces now render the same fact: Settings' Risk block, which states the
 * arithmetic behind today's budget under the fields that set it, and the
 * board's leg row, which states the budget itself beside the account it
 * belongs to.
 *
 * **Neither of them does the arithmetic.** `resolveSessionBudget` is the
 * engine's own resolver, pure and free of `db/` imports on purpose, so the
 * number the operator reads and the number that sizes his next entry cannot
 * disagree. What this module adds is the part that is *not* arithmetic and
 * would otherwise be written twice: normalising a wire row into the
 * resolver's shape, catching the throws that mean "this account takes no
 * order at all", and naming the five endings so each surface words them in
 * its own voice instead of re-deriving which ending it is looking at.
 *
 * **The words each surface renders are not here** — the Risk block's line and
 * the board cell's tooltip say different things to different questions. What
 * is here is the one word both surfaces must not spell differently
 * ({@link RISK_NOT_SET_STAMP}).
 *
 * It renders nothing, decides nothing about arming, and is read by no gate:
 * the phase is display only, and the live-account block stays the one
 * predicate that reads an account's identity.
 */

import {
  COMBINE_MLL_USD,
  parseAccountRiskPhase,
  resolveSessionBudget,
  type AccountRiskPhase,
  type SessionBudget,
  type SessionBudgetRow,
} from "@/lib/trading/orders/account-phase-sizer";
import { isPracticeAccount } from "@/lib/brokers/topstep/account-classification";
import { toCents } from "@/lib/trading/orders/pnl-math";

/**
 * The part of a `GET /api/accounts/risk` row both surfaces read.
 *
 * **Every nested object is optional and every field inside it nullable**, for
 * the reason the Risk block's `accountsOf` gives: the element type is
 * asserted at the fetch boundary rather than validated, so a body from a stub,
 * a proxy or a route one deploy behind must read as *no posture* rather than
 * throw inside a render. A surface that needs more of the row (the account
 * name, the daily gate, the payout stamp) extends this rather than replacing
 * it.
 */
export interface AccountRiskWireRow {
  accountId: number;
  broker: "topstep" | "tradovate";
  posture: { maxRiskPerTradeUsd: number; maxContracts: number } | null;
  riskPhase?: {
    phase: AccountRiskPhase;
    mllUsd: number | null;
    startBalanceUsd: number | null;
    /** Optional as well as nullable: a route one deploy behind omits it, and
     *  a `combine_press` row without it reads as the resolver's refusal. */
    pressAtUsd?: number | null;
    payoutTakenAt: string | null;
  } | null;
  eodSample?: {
    balanceUsd: number | null;
    peakUsd: number | null;
    sizesSessionStart: string | null;
    recordedAt: string | null;
  } | null;
}

/**
 * The five endings, named once.
 *
 * `unset` and `refused` are the two that stop the account trading, and they
 * are kept apart because the operator's move differs: one is a form to fill
 * in, the other is a row the rule model cannot price. `flat` and `sized` both
 * carry a live budget and differ only in whether the phase moved it. `lowest`
 * is a budget the account *fell back to* rather than one anybody chose, which
 * is why it is its own ending rather than a `sized` with null facts.
 */
export type AccountRiskReading =
  | { kind: "unset" }
  | { kind: "flat"; budgetUsd: number }
  | {
      kind: "sized";
      phase: AccountRiskPhase;
      budgetUsd: number;
      /**
       * The arithmetic behind the budget, and **nullable because the reader
       * does not get to invent an ending for a shape it does not recognise.**
       * The resolver answers these together with every non-stale budget, so
       * today they are always both present; the first cut folded the missing
       * case into the `flat` arm, whose sentence asserts *no account phase is
       * set* — a claim about a row that had just named one. A field a surface
       * can omit beats an arm that would lie.
       */
      headroomUsd: number | null;
      floorUsd: number | null;
      /** The close the budget was sized from, as a raw stamp — each surface
       *  formats its own date, or renders none. */
      closeStamp: string | null;
    }
  | {
      kind: "lowest";
      phase: AccountRiskPhase;
      budgetUsd: number;
      /** Whether any close has ever been recorded for this account. A row the
       *  sampler has never reached has no close at all; one whose stamp is a
       *  session old does, and saying "yet" about it would name a cause
       *  nobody checked. */
      everSampled: boolean;
    }
  | { kind: "refused"; reason: string };

/**
 * The row's phase columns in the shape the resolver reads.
 *
 * Optional-chained throughout for {@link AccountRiskWireRow}'s reason: a body
 * without these objects sizes as `off` rather than throwing.
 *
 * **The phase goes through `parseAccountRiskPhase` rather than being taken at
 * its word**, because the wire element is asserted rather than validated and
 * that is the one field an unrecognised value does real damage in: it reaches
 * the compact label map and renders the literal `undefined` beside a dollar
 * figure, and it reaches the resolver, which would size a row written by a
 * future version through today's combine buckets. The parser's own rule is
 * the fail-closed one — anything it does not recognise reads as `off`, which
 * is the inert value and the flat number the operator typed.
 */
export function budgetRowOf(row: AccountRiskWireRow): SessionBudgetRow {
  return {
    broker: row.broker,
    riskPhase: parseAccountRiskPhase(row.riskPhase?.phase ?? null),
    mllUsd: row.riskPhase?.mllUsd ?? null,
    startBalanceUsd: row.riskPhase?.startBalanceUsd ?? null,
    pressAtUsd: row.riskPhase?.pressAtUsd ?? null,
    eodBalanceUsd: row.eodSample?.balanceUsd ?? null,
    eodPeakUsd: row.eodSample?.peakUsd ?? null,
    eodSizesSessionStart: row.eodSample?.sizesSessionStart ?? null,
    maxRiskPerTradeUsd: row.posture?.maxRiskPerTradeUsd ?? null,
    maxContracts: row.posture?.maxContracts ?? null,
  };
}

/**
 * What this account's risk settings resolve to for the session `now` falls in.
 *
 * **`unset` is asked first and answered without calling the resolver.** An
 * account with no posture takes no trades whatever its phase says, and the
 * resolver's own sentence for that case names the phase — which is the wrong
 * subject for a row where the missing thing is the pair of numbers above it.
 *
 * **A throw is an ending, not an error.** The resolver throws for a busted
 * account, a combine on a loss limit nobody measured, and a phase on a
 * non-Topstep row; in every one of them the account takes no order, so the
 * sentence is carried through verbatim rather than swallowed. Those sentences
 * are the engine's own constants and are not reworded at any surface.
 */
export function readAccountRisk(row: AccountRiskWireRow, now: Date): AccountRiskReading {
  if (row.posture == null) return { kind: "unset" };
  let budget: SessionBudget;
  try {
    budget = resolveSessionBudget(budgetRowOf(row), now);
  } catch (err) {
    return { kind: "refused", reason: err instanceof Error ? err.message : String(err) };
  }
  const budgetUsd = budget.posture?.maxRiskPerTradeUsd;
  // A posture was present two lines up, so the resolver cannot have answered
  // without one. This is the branch that cannot happen rather than a state
  // worth wording.
  if (budgetUsd == null) return { kind: "unset" };
  if (budget.phase === "off") return { kind: "flat", budgetUsd };
  if (budget.basis === "stale_floor") {
    return {
      kind: "lowest",
      phase: budget.phase,
      budgetUsd,
      everSampled: row.eodSample?.sizesSessionStart != null,
    };
  }
  // The facts ride along nullable rather than routing a resolver answer this
  // reader does not recognise into an arm whose words are about a different
  // row — see `headroomUsd`.
  return {
    kind: "sized",
    phase: budget.phase,
    budgetUsd,
    headroomUsd: budget.headroomUsd,
    floorUsd: budget.floorUsd,
    closeStamp: row.eodSample?.recordedAt ?? budget.sizesSessionStart,
  };
}

/**
 * *This account has no risk per trade set.* Two words, two surfaces, one
 * constant — the Risk block's pill and the board leg row's risk cell.
 *
 * It is not a refusal and does not get the refusal voice: nothing is being
 * withheld by a rule, the operator simply has not filled the field in, and
 * the fix is on the form the pill sits on. What it must not become is two
 * spellings of one fact on two screens, which is the drift
 * [copy.md](../../docs/modules/ui/copy.md)'s one-constant rule exists to stop.
 */
export const RISK_NOT_SET_STAMP = "not set";

/**
 * The website facts the Risk prefill reads — `GET /api/accounts/risk`'s
 * `brokerFacts`, which is null unless the last status check heard Topstep's
 * website. Every field optional and nullable, for {@link AccountRiskWireRow}'s
 * reason; null is *unknown* and suggests nothing.
 */
export interface RiskPrefillFacts {
  startingBalanceUsd?: number | null;
  highestBalanceUsd?: number | null;
  maximumLossUsd?: number | null;
  dailyLossUsd?: number | null;
  personalDailyLossLimitUsd?: number | null;
  stage?: number | null;
}

/** Topstep's `stage` code for a Trading Combine — the one code observed with a
 *  meaning this form has a phase for (proposals/topstep-account-state.md). */
export const TOPSTEP_COMBINE_STAGE = 1;

/**
 * What the Risk form suggests from Topstep's own account record. Suggestions
 * only: the block fills them into **empty** fields, marks each as from Topstep
 * until it is edited or saved, and never touches risk per trade or max
 * contracts, which are the operator's alone.
 *
 * - **Maximum loss limit** is the gap between the balance the floor trails from
 *   and the floor itself — `highestBalance − maximumLoss`, or
 *   `startingBalance − maximumLoss` when the record carried no highest balance.
 *   Topstep's `maximumLoss` is the floor *in dollars of balance*, not the limit.
 *   Nothing is suggested once the floor has reached the starting balance: the
 *   limit has locked there and the gap no longer measures it.
 * - **Daily loss** is the operator's own Topstep limit (`personalDailyLossLimit`)
 *   and nothing else. Topstep's program limit (`dailyLoss`) is a broker rule
 *   the broker enforces itself; it is returned as `brokerDailyLossUsd` for the
 *   form to show beside the field, never to fill it.
 * - **Account phase** is Combine on stage 1, and only beside a suggested limit
 *   of exactly $2,000 — the one Combine sizes. No other stage code is known, so
 *   no other phase is suggested.
 */
export interface RiskPrefill {
  startBalanceUsd: number | null;
  mllUsd: number | null;
  dailyLossUsd: number | null;
  phase: Extract<AccountRiskPhase, "combine"> | null;
  /** Topstep's own daily loss limit — read-only context, never a field value. */
  brokerDailyLossUsd: number | null;
}

const NO_PREFILL: RiskPrefill = {
  startBalanceUsd: null,
  mllUsd: null,
  dailyLossUsd: null,
  phase: null,
  brokerDailyLossUsd: null,
};

const positive = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) && v > 0 ? v : null;

export function riskPrefillOf(facts: RiskPrefillFacts | null | undefined): RiskPrefill {
  if (facts == null) return NO_PREFILL;
  const start = facts.startingBalanceUsd;
  const startBalanceUsd = start != null && Number.isFinite(start) && start >= 0 ? start : null;
  const floor = positive(facts.maximumLossUsd);
  const anchor = positive(facts.highestBalanceUsd) ?? positive(start);
  let mllUsd: number | null = null;
  if (floor != null && anchor != null && startBalanceUsd != null && toCents(floor) < toCents(startBalanceUsd)) {
    const gapCents = toCents(anchor) - toCents(floor);
    mllUsd = gapCents > 0 ? gapCents / 100 : null;
  }
  return {
    startBalanceUsd,
    mllUsd,
    dailyLossUsd: positive(facts.personalDailyLossLimitUsd),
    phase:
      facts.stage === TOPSTEP_COMBINE_STAGE && mllUsd != null && toCents(mllUsd) === toCents(COMBINE_MLL_USD)
        ? "combine"
        : null,
    brokerDailyLossUsd: positive(facts.dailyLossUsd),
  };
}

/** The part of a Risk row the list decision reads. `status` is optional for
 *  the reason every nested object on the wire row is. */
export interface RiskListRow {
  posture: AccountRiskWireRow["posture"];
  practice: boolean | null;
  status?: { state: "ok" | "locked" | "dead" | null } | null;
}

/**
 * Whether Settings' Risk page lists this account.
 *
 * **An account is dropped only when nothing is set on it.** Two cases, and
 * both give way to a risk per trade — a row carrying one stays listed until it
 * is cleared, because hiding it would leave an armed account the operator could
 * neither see nor disarm:
 *
 * - **Its broker says it is dead** — failed, ineligible or closed. One that
 *   still carries a risk per trade is listed and stamped closed at broker: the
 *   status is one check's answer, and the engine reads no status at all. A
 *   `locked` account is listed — a lockout ends. A status never checked
 *   (`null`) is listed: the page hides an account on a broker's answer, never
 *   on a missing one.
 * - **A practice account on the production build, and any other account off
 *   it.** Prod still auto-trades a practice account. Staging auto-trades
 *   practice accounts only, so it lists nothing else. An account the app cannot
 *   classify (`practice` null) is not practice: listed on prod, hidden off it.
 *
 * Nothing is deleted either way: the row, its trades and its skips stay in the
 * database, and this decides only what the page renders.
 */
export function listedOnRisk(row: RiskListRow, opts: { production: boolean }): boolean {
  if (row.posture != null) return true;
  if (row.status?.state === "dead") return false;
  const practice = row.practice !== null && isPracticeAccount({ practice: row.practice });
  return opts.production ? !practice : practice;
}
