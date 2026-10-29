import { toCents } from "./pnl-math";
import { currentCmeSessionStart } from "../session/session";
import type { AccountRiskPosture } from "./risk-sizer";

/**
 * The session's risk budget, from the account's phase and its last close.
 *
 * The operator declares what the account *is* — a combine, a fresh funded
 * account, a funded account that has taken a payout — and this answers what
 * one entry may lose today. Its answer is an ordinary `AccountRiskPosture`
 * handed to `resolveRiskSizedContracts`: **the pure sizer's signature and
 * arithmetic do not change, `maxContracts` is untouched, and
 * `REVIEWED_MAX_CONTRACTS` still caps every entry.** Only the budget moves.
 *
 * Two properties carry the whole design and neither is negotiable.
 *
 * **The budget is set from the previous session's close and held for the
 * day.** Every bucket number was measured that way — the simulation fixed the
 * day's budget at the open and did not move it. Re-reading the live balance
 * per tick is a different posture (it steps up after a winner at a new high
 * and reads unrealized P&L), nobody measured it, and it is not built here.
 * The session is the one `currentCmeSessionStart(now)` returns, the same
 * anchor the daily P&L gate uses, and a close sample is stamped with the
 * start of the session it sizes.
 *
 * **An unknown state never sizes up.** A sample that is missing or stamped
 * for an older session runs the *lowest* budget of the phase rather than the
 * last one it knew; anything the function cannot make sense of — a phase on a
 * non-Topstep row, a combine on an MLL nobody measured, a close at or below
 * the floor — throws, and the engine's per-leg catch skips the tick exactly
 * as it does for the sizer's own throws. **The throws that are about the row
 * rather than the sample are asked first**, so a row nobody can price is
 * refused on the days the sampler missed too, not quietly sized at the floor.
 *
 * The rule model, the measurements behind every constant and the fail-closed
 * table are in [docs/strategies/accounts/phase-aware-sizer.md]. Do not add an
 * arm here that the spec does not carry.
 */

/**
 * What the operator declared the account is. **Declared, never inferred.**
 *
 * The live-account block is the only predicate in this platform that reads an
 * account *name*, and it stays that way — deriving "combine" from a `50KTC-`
 * prefix here would be a second one ([docs/modules/brokers/README.md]). The
 * only broker fact this reads is the row's `broker` tag, and it reads it to
 * refuse: the rule model is Topstep's.
 */
export type AccountRiskPhase =
  | "off"
  | "combine"
  | "funded_fresh"
  | "funded_paid"
  | "combine_press";

/**
 * The operator's own words for each phase, as the settings form offers them.
 * A line that says `funded_paid` out loud is internal shorthand
 * ([docs/modules/ui/copy.md]), and the engine's stale-budget warn names the
 * phase, so the spelling lives beside the enum rather than at that call site.
 */
export const ACCOUNT_RISK_PHASE_LABELS: Readonly<Record<AccountRiskPhase, string>> = {
  off: "Off",
  combine: "Combine",
  funded_fresh: "Funded, before first payout",
  funded_paid: "Funded, after a payout",
  combine_press: "Combine, press",
};

/**
 * The same four phases for a single-line row, on the pattern
 * `DEPLOYMENT_STATUS_LABELS_COMPACT` already sets: **two label maps, one
 * order, one owner.** The board's leg row states the account's phase beside
 * its budget and has room for a word, not for a clause — and the
 * discriminator between the two funded phases is at the *end* of the long
 * labels, so truncating them there would render "Funded, before first…" and
 * "Funded, after a…" as the same string.
 *
 * `off` keeps its own word so the map stays exhaustive; no surface renders
 * it, because a phase that is off is not a phase and the budget beside it is
 * simply the number the operator typed.
 */
export const ACCOUNT_RISK_PHASE_LABELS_COMPACT: Readonly<Record<AccountRiskPhase, string>> = {
  off: "Off",
  combine: "Combine",
  funded_fresh: "Funded, pre-payout",
  funded_paid: "Funded, post-payout",
  combine_press: "Combine, press",
};

/**
 * Which arm produced the budget, for the trade row's `paramSnapshot`.
 *
 * It is what lets a monthly review read *why* a trade was sized as it was: a
 * $350 trade on a day the operator thought was a $500 day is either a stale
 * sample or a threshold crossed, and the row has to say which.
 */
export type AccountRiskBasis =
  | "flat"
  | "bucket_500"
  | "bucket_350"
  | "bucket_225"
  | "locked"
  | "funded_flat"
  | "derisk"
  | "stale_floor";

/** The row's phase-relevant columns, already narrowed. `null` anywhere is the
 *  column being unset, and what that means differs by phase — see the throws. */
export interface SessionBudgetRow {
  broker: "topstep" | "tradovate";
  riskPhase: AccountRiskPhase;
  mllUsd: number | null;
  startBalanceUsd: number | null;
  /** The headroom at which `combine_press` sizes its top rung. Read by that
   *  phase alone; every other phase ignores it. */
  pressAtUsd: number | null;
  /** The balance at the most recent recorded session close. */
  eodBalanceUsd: number | null;
  /** The highest close on record. Monotone, written by `recordSessionClose`. */
  eodPeakUsd: number | null;
  /** The session that sample sizes, as `currentCmeSessionStart` renders it. */
  eodSizesSessionStart: string | null;
  maxRiskPerTradeUsd: number | null;
  maxContracts: number | null;
}

/** The budget, and the facts it was computed from. Every fact is `null` in
 *  phase `off`, where nothing but the flat pair was read. */
export interface SessionBudget {
  posture: AccountRiskPosture | null;
  phase: AccountRiskPhase;
  basis: AccountRiskBasis;
  headroomUsd: number | null;
  floorUsd: number | null;
  closeUsd: number | null;
  peakUsd: number | null;
  sizesSessionStart: string | null;
}

/**
 * The MLL the buckets below were measured against — the 50K combine's.
 *
 * **Any other MLL in `combine` throws rather than scaling.** The 100K and
 * 150K bands exist in the research and the operator decided 50K only, so a
 * 100K row sized by the 50K's bands would be a posture nobody measured.
 */
export const COMBINE_MLL_USD = 2000;

/**
 * The combine's three buckets and the headroom thresholds between them,
 * source [docs/strategies/accounts/phase-aware-sizer.md] §1, measured in
 * `combine-size.md` §3.1. Boundaries are inclusive at the top of each band.
 */
const COMBINE_HIGH_BUDGET_USD = 500;
const COMBINE_MID_BUDGET_USD = 350;
const COMBINE_HIGH_BAND_HEADROOM_USD = 1750;
const COMBINE_MID_BAND_HEADROOM_USD = 1250;

/**
 * `combine_press`'s two rungs — the combine's top two buckets with no $225
 * rung below them: 6.2 passes a year against 5.2 at flat $350 on the MNQ/MES
 * book, 2020 → Oct 2026 ([docs/strategies/research/combine-phase-sizing.md]).
 */
export const PRESS_BUDGET_USD = COMBINE_HIGH_BUDGET_USD;
export const PRESS_FLOOR_BUDGET_USD = COMBINE_MID_BUDGET_USD;
/** The threshold the same sweep named, offered as the field's starting value;
 *  the stored column is what sizes. */
export const PRESS_AT_SUGGESTED_USD = 1500;

/**
 * The baseline budget, and the ceiling no funded phase may exceed by any
 * path: the combine's lowest bucket, the fresh funded account's flat number,
 * and the top of the post-payout clamp. Every recorded XFA number rests on
 * it (`first-payout.md` §6).
 */
const BASE_BUDGET_USD = 225;

/**
 * The post-payout de-risk ramp: `225 × headroom ÷ 3000`, floored at $100 and
 * capped at the baseline, rounded **down** to the cent. De-risk only — the
 * funded account never inherits the combine's buckets.
 */
const DERISK_FULL_BUDGET_HEADROOM_USD = 3000;
const DERISK_MIN_BUDGET_USD = 100;

/** What the settings route says when the operator asks for a phase the
 *  account's history rules out. One sentence per rule, answered verbatim by
 *  every surface — see [docs/modules/ui/copy.md]. */
export const PAYOUT_PHASE_PATH_REFUSAL =
  `"Funded, after a payout" only follows "Funded, before first payout". A combine never takes ` +
  `a payout, so an account reaches it by passing, running as funded before its first payout, ` +
  `and moving here once one is paid.`;

export const POST_PAYOUT_PHASE_REFUSAL =
  `This account has taken a payout, so it stays on "Funded, after a payout". A funded account ` +
  `is never a combine again and never goes back to its pre-payout sizing. "Off" is the only ` +
  `other setting it can take.`;

export const NON_TOPSTEP_PHASE_REFUSAL =
  `Account phases follow Topstep's trailing loss limit, and this account is not with Topstep. ` +
  `Leave it on "Off" and set risk per trade by hand.`;

export const COMBINE_MLL_REFUSAL =
  `Combine sizing was measured on a 50K combine, whose loss limit is ` +
  `$${COMBINE_MLL_USD.toLocaleString()}. Set the loss limit to ` +
  `$${COMBINE_MLL_USD.toLocaleString()}, or leave the account on "Off".`;

/**
 * The three the *resolver* answers, in the same voice as the four above.
 *
 * These are not internal: the Risk block renders the throw's own sentence on
 * its read-only budget line, and the engine interpolates it into the
 * `entry_blocked` row the operator reads in `/logs`. They said things like
 * `risk phase combine: mll_usd must be $2000, got 3000` until 2026-09-10,
 * which is a column name and a mechanism rather than a rule
 * ([docs/modules/ui/copy.md]). Where a route constant above already states
 * the same rule, the resolver **throws that constant** rather than a second
 * wording — one rule, one sentence, every surface.
 *
 * The two builders exist because each has to name a number the operator can
 * check their own row against.
 */
export const PHASE_NEEDS_RISK_POSTURE_REFUSAL =
  `An account phase sizes under the account's own risk per trade and maximum contracts, and ` +
  `this account is missing one of them. Set both, or put the account on "Off".`;

/** Dollars as these sentences state them: thousands separated, cents only
 *  when there are any. Exported because `account-risk-block.tsx`'s
 *  unsigned-money formatting was a byte-identical second copy of this one —
 *  see [docs/modules/ui/design-language.md], "If a third surface needs
 *  unsigned money, lift this one rather than writing a third convention." */
export function usd(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `"invalid"` is a column holding something that parsed but is not a usable
 *  number — `NaN`, `Infinity` — which is a different fact from `null`'s
 *  "nobody filled this in" and must not read as the same "none set". */
export function phaseRuleParameterRefusal(
  label: string,
  value: number | null | "invalid",
): string {
  const state = value === null ? "none set" : value === "invalid" ? "an unusable value stored" : usd(value);
  return (
    `Sizing this account's phase needs its ${label}, and the account has ` +
    `${state}. Set it on the account, or put the account ` +
    `on "Off".`
  );
}

export function accountAtFloorRefusal(closeUsd: number, floorUsd: number): string {
  return (
    `This account last closed at ${usd(closeUsd)}, at or below its ${usd(floorUsd)} trailing ` +
    `floor, so it has no room left to risk. It takes no entries until it closes back above the ` +
    `floor — check the account's loss limit and starting balance if that floor looks wrong.`
  );
}

const PHASES: readonly AccountRiskPhase[] = [
  "off",
  "combine",
  "funded_fresh",
  "funded_paid",
  "combine_press",
];

/** The two phases that are a Topstep 50K combine: $2,000 loss limit, a
 *  starting balance, and unreachable once a payout is stamped. */
export function isCombinePhase(phase: AccountRiskPhase): phase is "combine" | "combine_press" {
  return phase === "combine" || phase === "combine_press";
}

export function isAccountRiskPhase(value: unknown): value is AccountRiskPhase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/**
 * A stored `risk_phase` as a phase. **Anything unrecognised reads as `off`**,
 * which is the inert value: the column is nullable with no `DEFAULT`, so a
 * row written before it existed and a row written by a future version must
 * both fall through to today's flat posture rather than to a bucket.
 */
export function parseAccountRiskPhase(raw: string | null): AccountRiskPhase {
  return isAccountRiskPhase(raw) ? raw : "off";
}

export function resolveSessionBudget(row: SessionBudgetRow | null, now: Date): SessionBudget {
  const flat = flatPostureOf(row);
  if (row == null || row.riskPhase === "off") {
    return {
      posture: flat,
      phase: "off",
      basis: "flat",
      headroomUsd: null,
      floorUsd: null,
      closeUsd: null,
      peakUsd: null,
      sizesSessionStart: null,
    };
  }

  const phase = row.riskPhase;
  // The route refuses this combination at write; the per-tick read does not
  // trust it, because the row can also be edited by anything that reaches the
  // table and the rule model has no meaning off Topstep.
  if (row.broker !== "topstep") {
    throw new Error(NON_TOPSTEP_PHASE_REFUSAL);
  }
  // The flat pair stays both-or-neither in every phase: it is the ceiling the
  // budget is min'd with, so a phase with no ceiling has no budget to state.
  if (flat == null) {
    throw new Error(PHASE_NEEDS_RISK_POSTURE_REFUSAL);
  }
  const capCents = toCents(flat.maxRiskPerTradeUsd);
  // Ahead of the stale arm, deliberately: the fallback is the *sample*'s and
  // not the configuration's. A row whose rule parameters make no sense is one
  // no arm can price, so answering it the lowest budget on the days the
  // sampler missed would size a posture nobody described rather than refusing
  // it — and the refusal is what tells the operator to fix the row.
  const rule = ruleParamsOf(phase, row);

  const sample = currentSampleOf(row, now);
  if (sample == null) {
    return {
      posture: postureOf(lowestBudgetCents(phase), capCents, flat.maxContracts),
      phase,
      basis: "stale_floor",
      headroomUsd: null,
      floorUsd: null,
      closeUsd: row.eodBalanceUsd,
      peakUsd: row.eodPeakUsd,
      sizesSessionStart: row.eodSizesSessionStart,
    };
  }

  const { floorCents, locked, peakCents } = floorOf(rule, sample.peakCents);
  const headroomCents = sample.closeCents - floorCents;
  // Busted, or the operator typed a floor the account is already under.
  // Either way no order: this is not a transient too-wide-stop skip.
  if (headroomCents <= 0) {
    throw new Error(accountAtFloorRefusal(sample.closeCents / 100, floorCents / 100));
  }

  const { cents, basis } = phaseBudget(phase, headroomCents, locked, rule?.pressAtCents ?? null);
  return {
    posture: postureOf(cents, capCents, flat.maxContracts),
    phase,
    basis,
    headroomUsd: headroomCents / 100,
    floorUsd: floorCents / 100,
    closeUsd: sample.closeCents / 100,
    peakUsd: peakCents / 100,
    sizesSessionStart: sample.sizesSessionStart,
  };
}

function flatPostureOf(row: SessionBudgetRow | null): AccountRiskPosture | null {
  if (row == null || row.maxRiskPerTradeUsd == null || row.maxContracts == null) return null;
  return { maxRiskPerTradeUsd: row.maxRiskPerTradeUsd, maxContracts: row.maxContracts };
}

/**
 * The sample, only if it sizes the session `now` falls in.
 *
 * A stamp for an older session is a close the app never took — a holiday, a
 * missed fan-out, an engine that was down — and the balance under it may be
 * days old. It is not "close enough": the budget it would produce could be
 * two buckets high.
 */
function currentSampleOf(
  row: SessionBudgetRow,
  now: Date,
): { closeCents: number; peakCents: number; sizesSessionStart: string } | null {
  if (row.eodBalanceUsd == null || row.eodPeakUsd == null) return null;
  if (row.eodSizesSessionStart == null) return null;
  if (row.eodSizesSessionStart !== currentCmeSessionStart(now)) return null;
  return {
    closeCents: toCents(row.eodBalanceUsd),
    peakCents: toCents(row.eodPeakUsd),
    sizesSessionStart: row.eodSizesSessionStart,
  };
}

function lowestBudgetCents(phase: Exclude<AccountRiskPhase, "off">): number {
  switch (phase) {
    case "combine":
    case "funded_fresh":
      return toCents(BASE_BUDGET_USD);
    case "funded_paid":
      return toCents(DERISK_MIN_BUDGET_USD);
    case "combine_press":
      return toCents(PRESS_FLOOR_BUDGET_USD);
    default:
      return unhandledPhase(phase);
  }
}

/** A phase added to the union and missed by a switch fails to compile here.
 *  Exported so the route and the Risk block decide refusal, rule fields and
 *  payout blocking through the same check. */
export function unhandledPhase(phase: never): never {
  throw new Error(`Unhandled account phase: ${String(phase)}`);
}

interface PhaseRule {
  mllCents: number;
  lockAtCents: number;
  /** `combine_press`'s threshold; `null` in every phase that does not read it. */
  pressAtCents: number | null;
}

/**
 * The phase's rule parameters, in cents, or `null` for the phase that reads
 * none — a funded account after a payout, whose limit reset with the payout.
 *
 * **Read before the sample is looked at**, so a row the rule model cannot
 * describe throws on every session rather than only on the ones a close was
 * recorded for.
 */
function ruleParamsOf(
  phase: Exclude<AccountRiskPhase, "off">,
  row: SessionBudgetRow,
): PhaseRule | null {
  switch (phase) {
    case "funded_paid":
      return null;
    case "combine":
    case "combine_press": {
      const mllCents = toCents(requirePositive(row.mllUsd, "trailing loss limit"));
      if (mllCents !== toCents(COMBINE_MLL_USD)) throw new Error(COMBINE_MLL_REFUSAL);
      const lockAtCents = toCents(requirePositive(row.startBalanceUsd, "starting balance"));
      const pressAtCents =
        phase === "combine_press"
          ? toCents(requirePositive(row.pressAtUsd, "press threshold"))
          : null;
      return { mllCents, lockAtCents, pressAtCents };
    }
    case "funded_fresh":
      return {
        mllCents: toCents(requirePositive(row.mllUsd, "trailing loss limit")),
        // A funded account opens at 0 and locks there, so 0 is a real value
        // here rather than an unset column.
        lockAtCents: toCents(requireNonNegative(row.startBalanceUsd, "starting balance")),
        pressAtCents: null,
      };
    default:
      return unhandledPhase(phase);
  }
}

/**
 * `min(lockAt, peak − MLL)`, and the `min` is the whole point.
 *
 * `max` would put a day-one 50K combine at its own floor — `max(50,000,
 * 48,000)` is 50,000 and headroom 0 — which is a busted account on the day it
 * opened. Worked: peak 50,000 → 48,000; peak 51,500 → 49,500; peak 52,000 →
 * 50,000; peak 53,000 → still 50,000, because the floor stops rising at the
 * starting balance.
 *
 * The post-payout floor is 0 instead: the limit reset with the payout, so
 * headroom is the balance itself.
 *
 * Returns the peak it trailed from, so the facts on the trade row reproduce
 * the floor from the formula above.
 */
function floorOf(
  rule: PhaseRule | null,
  recordedPeakCents: number,
): { floorCents: number; locked: boolean; peakCents: number } {
  if (rule == null) return { floorCents: 0, locked: false, peakCents: recordedPeakCents };
  // The stored peak is the highest *close* on record, so a losing first day
  // seeds it below the start; Topstep trails the highest end-of-day balance
  // including the starting balance (A96).
  const peakCents = Math.max(recordedPeakCents, rule.lockAtCents);
  const trailingCents = peakCents - rule.mllCents;
  return {
    floorCents: Math.min(rule.lockAtCents, trailingCents),
    locked: trailingCents >= rule.lockAtCents,
    peakCents,
  };
}

function phaseBudget(
  phase: Exclude<AccountRiskPhase, "off">,
  headroomCents: number,
  locked: boolean,
  pressAtCents: number | null,
): { cents: number; basis: AccountRiskBasis } {
  switch (phase) {
    case "funded_fresh":
      return { cents: toCents(BASE_BUDGET_USD), basis: "funded_flat" };
    case "funded_paid": {
      const scaledCents = Math.floor(
        (toCents(BASE_BUDGET_USD) * headroomCents) / toCents(DERISK_FULL_BUDGET_HEADROOM_USD),
      );
      return {
        cents: Math.min(
          Math.max(scaledCents, toCents(DERISK_MIN_BUDGET_USD)),
          toCents(BASE_BUDGET_USD),
        ),
        basis: "derisk",
      };
    }
    case "combine":
      // The floor stopped rising: the trailing limit has locked at the starting
      // balance and further highs buy no room, so the account is on its lowest
      // bucket however far above the floor it closed.
      if (locked) return { cents: toCents(BASE_BUDGET_USD), basis: "locked" };
      if (headroomCents >= toCents(COMBINE_HIGH_BAND_HEADROOM_USD)) {
        return { cents: toCents(COMBINE_HIGH_BUDGET_USD), basis: "bucket_500" };
      }
      if (headroomCents >= toCents(COMBINE_MID_BAND_HEADROOM_USD)) {
        return { cents: toCents(COMBINE_MID_BUDGET_USD), basis: "bucket_350" };
      }
      return { cents: toCents(BASE_BUDGET_USD), basis: "bucket_225" };
    case "combine_press":
      // `locked` is deliberately not read: the press was simulated on headroom
      // alone, and a locked account far above its floor still presses.
      if (pressAtCents == null) {
        throw new Error(phaseRuleParameterRefusal("press threshold", null));
      }
      return headroomCents >= pressAtCents
        ? { cents: toCents(PRESS_BUDGET_USD), basis: "bucket_500" }
        : { cents: toCents(PRESS_FLOOR_BUDGET_USD), basis: "bucket_350" };
    default:
      return unhandledPhase(phase);
  }
}

/** The phase's budget under the flat field, which is a **ceiling** in every
 *  phase and never a floor — it is what makes the funded phases incapable of
 *  exceeding the baseline by any path. */
function postureOf(
  budgetCents: number,
  capCents: number,
  maxContracts: number,
): AccountRiskPosture {
  return { maxRiskPerTradeUsd: Math.min(budgetCents, capCents) / 100, maxContracts };
}

/** `label` is the operator's own name for the column — *trailing loss limit*,
 *  *starting balance* — because the sentence it lands in is one they read. */
function requirePositive(value: number | null, label: string): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      phaseRuleParameterRefusal(label, value == null ? null : Number.isFinite(value) ? value : "invalid"),
    );
  }
  return value;
}

function requireNonNegative(value: number | null, label: string): number {
  if (value == null || !Number.isFinite(value) || value < 0) {
    throw new Error(
      phaseRuleParameterRefusal(label, value == null ? null : Number.isFinite(value) ? value : "invalid"),
    );
  }
  return value;
}
