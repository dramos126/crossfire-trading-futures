import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  autoTradeVerdictsOrUnverified,
  getAccountDailyPnlLimits,
  getAccountRiskPhase,
  getAccountRiskSettings,
  listAccountRiskPostures,
  logAccountRiskChange,
  setAccountDailyPnlLimits,
  setAccountRiskPhase,
  setAccountRiskPosture,
  type AccountRiskPhaseInput,
} from "@/lib/db/account-brokers";
import { MAX_CONTRACTS_REFUSAL, REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import {
  COMBINE_MLL_REFUSAL,
  COMBINE_MLL_USD,
  NON_TOPSTEP_PHASE_REFUSAL,
  PAYOUT_PHASE_PATH_REFUSAL,
  POST_PAYOUT_PHASE_REFUSAL,
  isAccountRiskPhase,
  unhandledPhase,
  type AccountRiskPhase,
} from "@/lib/trading/orders/account-phase-sizer";
import { roundToCents } from "@/lib/trading/orders/pnl-math";

/**
 * The account's risk settings: the **posture** — what one entry may lose and
 * the contract ceiling regardless of that budget — and the **daily P&L gate**,
 * re-scoped here from the deployment because Topstep's daily loss is an
 * account rule.
 *
 * **The ceiling is per account and its maximum is not.** `REVIEWED_MAX_CONTRACTS`
 * is a reviewed constant with a measured run behind it, so this route accepts a
 * lower ceiling on any account and refuses a higher one on every account. That
 * split is the whole point: the number that decides how much size a tight stop
 * buys should not be raisable from a form.
 *
 * **The two travel together on the wire and are stored apart, deliberately.**
 * One Save on one row writes both, so the operator edits one thing; but the
 * posture is both-fields-or-neither (a budget with no ceiling sizes off
 * whatever today's stop happens to be) while the daily numbers are independent
 * and default off. Writing them through one setter would force one of those two
 * readings onto the other.
 *
 * It reads the **catalogue** (`account_brokers`) rather than fanning out to
 * the brokers, deliberately: this is a settings surface for accounts the app
 * already knows about, and a broker outage must not empty the form the
 * operator is editing. An account the catalogue has not seen has no row to
 * update, which is the 404 below — the fix is the account picker's fan-out,
 * not an insert from here.
 *
 * `GET` returns every catalogued account with its posture (`null` where none is
 * set) and its daily gate (zeros where none is set). `PUT` writes one account's
 * of each, or clears both when the posture fields are absent.
 *
 * **The account phase is the third thing on the row, and it is the one whose
 * refusals are rules rather than validation.** It says what the account *is* —
 * a combine, a funded account before or after its first payout — and the
 * per-session budget is computed from it and the last recorded close. An
 * absent `riskPhase` leaves it unchanged, for the reason an absent daily field
 * does; clearing the posture clears the phase with it and leaves the payout
 * stamp and the recorded closes alone.
 *
 * **On a PUT, an absent daily field is unchanged and an explicit `0` or `null`
 * is off.** The posture is both-fields-or-neither so it can read absence as a
 * clear; the daily numbers are independent and a caller that names only the
 * posture is not asking about them. Reading absence as `0` there disarmed a set
 * loss limit with no error and no log — a gate that stops firing looks like a
 * good day.
 *
 * **Every row carries the server's auto-trade verdict (`autoTrade`)**, so the
 * form's refusal is the engine's and the client never asks the predicate.
 */
export function GET(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  return NextResponse.json({ accounts: riskRowsWithVerdicts() });
}

/**
 * The catalogue's rows with `autoTradeVerdictsOrUnverified` over them — the
 * predicate the deploy routes, the engine and `/api/accounts` ask, read from
 * the same persisted catalogue, never from a broker call: joining to the
 * fan-out would refuse a catalogued account while its broker arm is down. A
 * row the read does not answer, or a read that throws, is refused as
 * unverified, the way the gates would refuse it (bugs.md A38).
 */
function riskRowsWithVerdicts() {
  const rows = listAccountRiskPostures();
  const verdictFor = autoTradeVerdictsOrUnverified(rows.map((r) => r.accountId), "api.accounts.risk");
  return rows.map((r) => ({ ...r, autoTrade: verdictFor(r.accountId) }));
}

interface RiskPostureBody {
  accountId?: unknown;
  maxRiskPerTradeUsd?: unknown;
  maxContracts?: unknown;
  dailyMaxLossUsd?: unknown;
  dailyMaxProfitUsd?: unknown;
  dailyPnlIncludeUnrealized?: unknown;
  riskPhase?: unknown;
  mllUsd?: unknown;
  startBalanceUsd?: unknown;
  pressAtUsd?: unknown;
}

/** Money, so cents: two decimal places and nothing finer. The upper bound is
 *  a sanity rail rather than a rule — a five-figure per-trade budget on a
 *  combine is a typo, and the form has no undo. */
const MAX_RISK_CEILING_USD = 100_000;

/** The same rail one order of magnitude out, for the two fields that hold a
 *  balance rather than a risk: a 50K combine states $50,000 and the risk
 *  ceiling would refuse it. */
const MAX_ACCOUNT_BALANCE_USD = 1_000_000;

/** The cause `account_risk_settings_changed` names for a save on this form. */
const RISK_SETTINGS_SAVED = "saved in Settings";

/**
 * A daily gate field the body **named**: an explicit `null` or `0` turns the
 * side off, anything else is dollars and cents above zero.
 *
 * **Absent is not this function's case, and the difference is a set loss limit.**
 * A PUT that names the posture and omits the daily fields is not asking for them
 * to be cleared, and reading absence as `0` here made the gate's only writer
 * silently disarm a limit the operator had set — the exact failure
 * [persistence/README.md](../../../../../docs/modules/persistence/README.md)
 * warns about, arriving through the route rather than the seed upsert. The
 * caller keeps the stored value for an absent field and only calls this for one
 * the body carries.
 *
 * **A daily limit is not the posture and does not refuse on absence.** The
 * sizer cannot invent a budget, so a missing posture stops the account; a
 * missing daily limit is the operator not asking for a gate, which is exactly
 * what `0` meant on the retired `CommonParams` keys.
 */
function parseDailyLimit(raw: unknown, label: string): number | { error: string } {
  if (raw === null) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return { error: `${label} must be $0 or more. 0 turns it off.` };
  }
  if (roundToCents(raw) !== raw) return { error: `${label} is dollars and cents.` };
  if (raw > MAX_RISK_CEILING_USD) {
    return { error: `${label} must be $${MAX_RISK_CEILING_USD.toLocaleString()} or less.` };
  }
  return raw;
}

/** A balance or a limit the operator typed: dollars and cents, inside the
 *  sanity rail. `min` is the field's own floor — a funded account really does
 *  start at $0, and a combine's starting balance really cannot. */
function parseAccountAmount(
  raw: unknown,
  label: string,
  min: 0 | 0.01,
): number | { error: string } {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min) {
    return { error: min === 0 ? `${label} must be $0 or more.` : `${label} must be more than $0.` };
  }
  if (roundToCents(raw) !== raw) return { error: `${label} is dollars and cents.` };
  if (raw > MAX_ACCOUNT_BALANCE_USD) {
    return { error: `${label} must be $${MAX_ACCOUNT_BALANCE_USD.toLocaleString()} or less.` };
  }
  return raw;
}

type PhaseDecision =
  | { kind: "unchanged" }
  | { kind: "write"; input: AccountRiskPhaseInput }
  | { kind: "refused"; status: number; error: string };

/**
 * What the body asks of the account's phase, and the four refusals that are
 * rules rather than validation errors.
 *
 * **This route is the guard, and the phase resolver does not trust it** — it
 * throws on any combination that reaches it anyway. What the refusals buy is
 * that the operator meets the rule at the form, in the voice of a rule
 * ([ui/copy.md](../../../../../docs/modules/ui/copy.md)), rather than as an
 * account that saves cleanly and then takes no trades.
 *
 * The one that is genuinely permanent is the payout stamp: once an account
 * has been saved as funded-after-a-payout it can never be a combine again,
 * and the cost — a mis-click strands that row on `Off` or on the post-payout
 * phase for good — is accepted deliberately.
 */
function resolvePhaseFromBody(accountId: number, body: RiskPostureBody): PhaseDecision {
  // Absent is unchanged, as it is for the daily gate: a caller that names only
  // the posture is not asking about the phase.
  if (body.riskPhase === undefined) return { kind: "unchanged" };
  const refuse = (error: string): PhaseDecision => ({ kind: "refused", status: 400, error });
  if (!isAccountRiskPhase(body.riskPhase)) {
    return refuse(
      "Account phase must be Off, Combine, Combine press, Funded before first payout, or " +
        "Funded after a payout.",
    );
  }
  const phase = body.riskPhase;
  const stored = getAccountRiskPhase(accountId);
  if (stored == null) return { kind: "refused", status: 404, error: "Unknown account" };
  const none = { mllUsd: null, startBalanceUsd: null, pressAtUsd: null };
  // Off clears the rule parameters with it: they describe a phase that is no
  // longer set, and the sizer reads the flat number alone.
  if (phase === "off") return { kind: "write", input: { phase, ...none } };
  if (stored.broker !== "topstep") return refuse(NON_TOPSTEP_PHASE_REFUSAL);
  switch (phase) {
    case "funded_paid":
      if (stored.payoutTakenAt == null && !reachesPayoutFrom(stored.phase)) {
        return refuse(PAYOUT_PHASE_PATH_REFUSAL);
      }
      // The post-payout phase reads none: its floor is zero and its headroom
      // is the balance, so it stores none rather than keeping a stale combine's.
      return { kind: "write", input: { phase, ...none } };
    case "combine":
    case "combine_press": {
      if (stored.payoutTakenAt != null) return refuse(POST_PAYOUT_PHASE_REFUSAL);
      // Both combine phases were measured on the 50K's $2,000 limit alone, so
      // any other number is refused here rather than scaled — including none.
      if (body.mllUsd !== COMBINE_MLL_USD) return refuse(COMBINE_MLL_REFUSAL);
      const startBalance = parseAccountAmount(body.startBalanceUsd, "Starting balance", 0.01);
      if (typeof startBalance !== "number") return refuse(startBalance.error);
      // Stored only for the phase that reads it, so a phase change away from
      // the press nulls it rather than leaving a number nothing sizes from.
      const pressAt =
        phase === "combine_press"
          ? parseAccountAmount(body.pressAtUsd, "Press threshold", 0.01)
          : null;
      if (pressAt !== null && typeof pressAt !== "number") return refuse(pressAt.error);
      return {
        kind: "write",
        input: { phase, mllUsd: COMBINE_MLL_USD, startBalanceUsd: startBalance, pressAtUsd: pressAt },
      };
    }
    case "funded_fresh": {
      if (stored.payoutTakenAt != null) return refuse(POST_PAYOUT_PHASE_REFUSAL);
      const mll = parseAccountAmount(body.mllUsd, "Maximum loss limit", 0.01);
      if (typeof mll !== "number") return refuse(mll.error);
      const startBalance = parseAccountAmount(body.startBalanceUsd, "Starting balance", 0);
      if (typeof startBalance !== "number") return refuse(startBalance.error);
      return {
        kind: "write",
        input: { phase, mllUsd: mll, startBalanceUsd: startBalance, pressAtUsd: null },
      };
    }
    default:
      return unhandledPhase(phase);
  }
}

/** Whether the stored phase is one an account may move to "Funded, after a
 *  payout" from without a payout already stamped: only a funded phase is. */
function reachesPayoutFrom(stored: AccountRiskPhase): boolean {
  switch (stored) {
    case "off":
    case "combine":
    case "combine_press":
      return false;
    case "funded_fresh":
    case "funded_paid":
      return true;
    default:
      return unhandledPhase(stored);
  }
}

export async function PUT(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;

  let body: RiskPostureBody;
  try {
    body = (await req.json()) as RiskPostureBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.accountId !== "number" || !Number.isInteger(body.accountId)) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  // Clearing is both posture fields absent or null together. A half-cleared
  // posture is not a state the sizer can read, so it is not a state this
  // accepts — and clearing the posture clears the daily gate with it, because
  // the row is one thing to the operator and an account that takes no trades
  // has no day to limit.
  const before = getAccountRiskSettings(body.accountId);
  const clearing = body.maxRiskPerTradeUsd == null && body.maxContracts == null;
  if (clearing) {
    if (!setAccountRiskPosture(body.accountId, null)) {
      return NextResponse.json({ error: "Unknown account" }, { status: 404 });
    }
    setAccountDailyPnlLimits(body.accountId, null);
    // The phase goes with the posture: it sets a budget under a ceiling that
    // is no longer there. The payout stamp and the recorded closes survive —
    // the app never forgets that this account took a payout.
    setAccountRiskPhase(body.accountId, null);
    logAccountRiskChange(body.accountId, before, RISK_SETTINGS_SAVED);
    return NextResponse.json({ accounts: riskRowsWithVerdicts() });
  }

  const risk = body.maxRiskPerTradeUsd;
  const contracts = body.maxContracts;
  if (typeof risk !== "number" || !Number.isFinite(risk) || risk <= 0) {
    return NextResponse.json(
      { error: "Risk per trade must be more than $0." },
      { status: 400 },
    );
  }
  // Through `roundToCents`, not `Math.round(risk * 100) !== risk * 100`:
  // `19.99 * 100` is `1998.9999999999998`, so the inline form refuses a budget
  // the operator can type on the form beside it. Same unit the sizer's
  // denominator is in.
  if (roundToCents(risk) !== risk) {
    return NextResponse.json({ error: "Risk per trade is dollars and cents." }, { status: 400 });
  }
  if (risk > MAX_RISK_CEILING_USD) {
    return NextResponse.json(
      { error: `Risk per trade must be $${MAX_RISK_CEILING_USD.toLocaleString()} or less.` },
      { status: 400 },
    );
  }
  if (typeof contracts !== "number" || !Number.isInteger(contracts) || contracts < 1) {
    return NextResponse.json(
      { error: "Maximum contracts must be a whole number, at least 1." },
      { status: 400 },
    );
  }
  // The ceiling above the ceiling, and the one number on this form the operator
  // may lower but not raise: `REVIEWED_MAX_CONTRACTS` is reviewed against a
  // measured run, so the refusal is passed through verbatim rather than reworded
  // here — see [ui/copy.md](../../../../../docs/modules/ui/copy.md).
  if (contracts > REVIEWED_MAX_CONTRACTS) {
    return NextResponse.json({ error: MAX_CONTRACTS_REFUSAL }, { status: 400 });
  }

  // Absent means unchanged; explicit `null` or `0` means off. JSON has no
  // `undefined`, so a key the body omitted is exactly the key that arrives here
  // as one — no `in` test needed, and no way for a non-object body to reach a
  // different answer.
  const stored = getAccountDailyPnlLimits(body.accountId);
  const dailyLoss =
    body.dailyMaxLossUsd === undefined
      ? stored.dailyMaxLossUsd
      : parseDailyLimit(body.dailyMaxLossUsd, "Daily loss limit");
  if (typeof dailyLoss !== "number") {
    return NextResponse.json({ error: dailyLoss.error }, { status: 400 });
  }
  const dailyProfit =
    body.dailyMaxProfitUsd === undefined
      ? stored.dailyMaxProfitUsd
      : parseDailyLimit(body.dailyMaxProfitUsd, "Daily profit limit");
  if (typeof dailyProfit !== "number") {
    return NextResponse.json({ error: dailyProfit.error }, { status: 400 });
  }
  const includeUnrealized =
    body.dailyPnlIncludeUnrealized === undefined
      ? stored.dailyPnlIncludeUnrealized
      : body.dailyPnlIncludeUnrealized === true;

  const phase = resolvePhaseFromBody(body.accountId, body);
  if (phase.kind === "refused") {
    return NextResponse.json({ error: phase.error }, { status: phase.status });
  }

  if (
    !setAccountRiskPosture(body.accountId, {
      maxRiskPerTradeUsd: risk,
      maxContracts: contracts,
    })
  ) {
    return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  }
  // The posture write already proved the row exists, so this cannot 404 behind
  // it; a false here would mean the row vanished between two statements.
  setAccountDailyPnlLimits(body.accountId, {
    dailyMaxLossUsd: dailyLoss,
    dailyMaxProfitUsd: dailyProfit,
    dailyPnlIncludeUnrealized: includeUnrealized,
  });
  if (phase.kind === "write") setAccountRiskPhase(body.accountId, phase.input);
  logAccountRiskChange(body.accountId, before, RISK_SETTINGS_SAVED);
  return NextResponse.json({ accounts: riskRowsWithVerdicts() });
}
