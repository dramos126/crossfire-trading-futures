"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listedOnRisk,
  readAccountRisk,
  riskPrefillOf,
  RISK_NOT_SET_STAMP,
  type AccountRiskWireRow,
  type RiskPrefillFacts,
} from "@/components/account/account-risk-view";
import { isProductionEnv } from "@/lib/env";
import { FieldBadge } from "@/components/field-badge";
import { InfoIcon } from "@/components/info-icon";
import type {
  AccountTradingIdentity,
  AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";
import { accountAutoTrade, toVerdict } from "@/lib/hooks/use-trading/account-row";
import { classifyAccount } from "@/lib/brokers/topstep/account-classification";
import { MAX_CONTRACTS_REFUSAL, REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import {
  ACCOUNT_RISK_PHASE_LABELS,
  COMBINE_MLL_REFUSAL,
  COMBINE_MLL_USD,
  NON_TOPSTEP_PHASE_REFUSAL,
  POST_PAYOUT_PHASE_REFUSAL,
  PRESS_AT_SUGGESTED_USD,
  PRESS_BUDGET_USD,
  PRESS_FLOOR_BUDGET_USD,
  isAccountRiskPhase,
  isCombinePhase,
  unhandledPhase,
  usd,
} from "@/lib/trading/orders/account-phase-sizer";
import { toCents } from "@/lib/trading/orders/pnl-math";
import type { AccountRiskPhase } from "@/lib/trading/orders/account-phase-sizer";
import { TRADING_TIMEZONE } from "@/lib/trading/strategy-types";
import { MASKED_USD, maskUsdFigures } from "@/components/privacy/privacy-model";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";

/**
 * The account risk posture, one row per account the app knows about.
 *
 * **This is the only place a contract count is decided.** The engine sizes
 * each entry down to the largest count whose loss at that signal's stop fits
 * the per-trade budget, capped by the ceiling here, and skips the entry when
 * even one contract does not fit. There is no per-deployment size any more
 * and no per-leg override.
 *
 * **It is a table, which is the idiom it already was without saying so.** It
 * rendered as a stack of bordered panels, each field carrying its own
 * uppercase label — so six accounts printed thirty-odd labels for six
 * distinct questions, and no two rows' fields lined up. One account is a row,
 * one setting is a column, the labels are column headers, and the bands are
 * zebra: the shipped rules for every list in this app, which a panel stack
 * was sidestepping rather than satisfying. **It is not a new settings idiom
 * and it is not one of the pickers** — `ProviderSlotSelector` is choose-one-
 * of-N and `SettingsTestConnectionRow` is a probe result, and a row of
 * numbers per account is neither.
 *
 * **The prose moved onto the columns it is about.** Five paragraphs stood
 * above the first field, which is a help page in front of a form; each is now
 * the `InfoIcon` of the header it describes, verbatim, with the one sentence
 * that is about the whole block — an account with no risk set takes no
 * trades — left in the lead.
 *
 * **The ceiling field is bounded and the bound is not editable here.** A
 * contract ceiling the operator can raise is not a ceiling, so
 * `REVIEWED_MAX_CONTRACTS` bounds every account's and this form only lowers
 * it. The row states the number and where it comes from: an operator who
 * cannot see the ceiling that sized their entry down is worse off than one
 * who can see it and cannot move it.
 *
 * **An account with no posture set does not trade.** The sizer refuses rather
 * than picking a number, which is the same direction the live-account block
 * takes on an account it cannot classify. The row says so rather than
 * rendering a blank pair of fields the operator reads as a default — and it
 * says it in the same two words the board's leg row uses, from one constant.
 *
 * **A row says what class the account is and whether the platform will trade
 * it.** Setting a budget on an account the trading policy refuses is a
 * dead-end the form used to accept in silence — the number saves, the engine
 * withholds every deployment on that account, and nothing on this screen
 * connects the two. The class comes from `classifyAccount`; the verdict is the
 * server's, the row's `autoTrade` that `/api/accounts/risk` reads from the
 * catalogue through the predicate the engine asks, read through
 * `accountAutoTrade` so a row without it is refused. Asking the predicate here
 * could not see a catalogue row the seed failed to write (bugs.md A38).
 * **The verdict is never re-derived from the class** —
 * `=== "LIVE"` at a new site is the second comparison brokers/README.md
 * forbids, and it would silently disagree with the policy the day a class
 * changes sides.
 *
 * **The account phase is a declaration, not a number.** The operator says
 * what the account *is* — a combine, a funded account before or after its
 * first payout — and the engine sizes the session from that and the last
 * recorded close. Risk per trade above stays the ceiling in every phase,
 * which is why the phase can never size an account up past the number on the
 * form. The four refusals the route answers are rules rather than validation
 * errors and are rendered verbatim from their own constants; the one this
 * form pre-empts is the combine's loss limit, refused at the field because a
 * save that cannot succeed is worse met after a round trip.
 *
 * The accounts come from `account_brokers` — the catalogue every
 * `searchAccounts` fan-out seeds — rather than from a broker call, so a
 * broker being down does not empty this form. An account missing from it is
 * fixed by loading the Dashboard, which is what seeds the catalogue.
 *
 * **Only accounts that can still trade are listed** (`listedOnRisk`): one its
 * broker reports dead drops off, and so does a practice account on the
 * production build — each only once no risk is set on it; a dead one still
 * carrying a risk is stamped closed at broker, and a locked one stays listed
 * with the lock's reason and end on its second line. The status is a stored
 * answer the Settings page refreshes when it opens (`statusCheck`); the list
 * re-reads the catalogue once that check settles, and a check that failed
 * leaves the last answer standing and says so.
 */

/** Where Settings' open-time account-status check is. Owned by the workbench,
 *  which fires it once per visit. */
export type AccountStatusCheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; failed: string[] }
  | { kind: "error"; message: string };

const STATUS_CHECK_IDLE: AccountStatusCheckState = { kind: "idle" };

const BROKER_NAMES: Record<string, string> = { topstep: "Topstep", tradovate: "Tradovate" };

interface RiskRow extends AccountRiskWireRow {
  name: string | null;
  /** The daily P&L gate, re-scoped here from the deployment. Zeros are "off",
   *  which is what an account with nothing set reads as — unlike `posture`,
   *  whose `null` stops the account trading.
   *
   *  **The wire carries a third field, `dailyPnlIncludeUnrealized`, and this
   *  row deliberately does not.** Nothing it could change is reachable from
   *  here: the engine's entry path is flat by construction and passes
   *  `unrealized: 0` whatever the flag says ([engine.md](../../docs/modules/trading/engine.md)),
   *  and the only surface the flag labels — the daily-gate pill's `R/U` suffix —
   *  has no component rendering it. A control for it would be a switch with
   *  nothing behind it. It comes back with the badge, not before. */
  dailyPnl: {
    dailyMaxLossUsd: number;
    dailyMaxProfitUsd: number;
  };
  practice: boolean | null;
  status?: {
    state: "ok" | "locked" | "dead" | null;
    checkedAt: string | null;
    lockoutReason?: string | null;
    lockoutUntil?: string | null;
  } | null;
  /** What Topstep's website last reported; the prefill reads it. */
  brokerFacts?: RiskPrefillFacts | null;
  /** The server's auto-trade verdict. Read through `accountAutoTrade`, never
   *  directly: a route one deploy behind omits it, and that must read refused. */
  autoTrade: AutoTradeVerdict;
}

/** The fields Topstep can suggest a value for. Risk per trade and max
 *  contracts are never among them: those are the operator's alone. */
type PrefillField = "startBalance" | "mll" | "dailyLoss" | "phase";

/** Every field on one row, as strings, because they are `<input>` values —
 *  except the phase, which is a `<select>` over a closed set. */
interface RiskDraft {
  risk: string;
  contracts: string;
  dailyLoss: string;
  dailyProfit: string;
  phase: AccountRiskPhase;
  mll: string;
  startBalance: string;
  pressAt: string;
  /** The fields holding a Topstep suggestion the operator has not touched. */
  fromTopstep: PrefillField[];
}

const EMPTY_DRAFT: RiskDraft = {
  risk: "",
  contracts: "",
  dailyLoss: "",
  dailyProfit: "",
  phase: "off",
  mll: "",
  startBalance: "",
  pressAt: "",
  fromTopstep: [],
};

/** The badge beside a field whose value Topstep suggested. */
export const FROM_TOPSTEP_BADGE = "from Topstep";

/**
 * Fill Topstep's suggestions into a row's **empty** fields, and keep a field
 * that still holds an untouched suggestion in step with the latest record.
 * A value the operator typed or saved is never overwritten.
 *
 * The daily loss field and the phase read *off* whether the operator chose
 * that or never touched them, so those two are filled only on an account that
 * has never been saved — one with no risk per trade. A refused account takes
 * no suggestions: its fields are disabled.
 */
function withPrefill(draft: RiskDraft, row: RiskRow): RiskDraft {
  if (!accountAutoTrade(row).permitted) return draft;
  const p = riskPrefillOf(row.brokerFacts);
  const neverSaved = row.posture == null;
  const next: RiskDraft = { ...draft, fromTopstep: [] };
  const fillText = (field: "startBalance" | "mll" | "dailyLoss", value: number | null, open: boolean) => {
    const held = draft.fromTopstep.includes(field);
    if (value != null && (held || open)) {
      next[field] = String(value);
      next.fromTopstep.push(field);
    } else if (held) {
      next[field] = EMPTY_DRAFT[field];
    }
  };
  fillText("startBalance", p.startBalanceUsd, draft.startBalance.trim() === "");
  fillText("mll", p.mllUsd, draft.mll.trim() === "");
  fillText("dailyLoss", p.dailyLossUsd, neverSaved && draft.dailyLoss.trim() === "");
  const phaseHeld = draft.fromTopstep.includes("phase");
  if (p.phase != null && row.broker === "topstep" && (phaseHeld || (neverSaved && draft.phase === "off"))) {
    next.phase = p.phase;
    next.fromTopstep.push("phase");
  } else if (phaseHeld) {
    next.phase = EMPTY_DRAFT.phase;
  }
  return next;
}

/** Read-only context on the row's second line. */
export function topstepDailyLossLine(usdValue: number): string {
  return `Topstep daily loss limit ${usd(usdValue)}`;
}

/** A field the operator edited is theirs from then on. */
function edited(draft: RiskDraft, field: PrefillField, patch: Partial<RiskDraft>): RiskDraft {
  return { ...draft, ...patch, fromTopstep: draft.fromTopstep.filter((f) => f !== field) };
}

/**
 * The five phases in the order the form offers them: safest first, most
 * aggressive last. The words are `ACCOUNT_RISK_PHASE_LABELS`' — the engine's
 * stale-budget warn names the phase from the same map, so a rewording moves
 * both — and each carries what it does to size, because a select option has to
 * stand alone.
 */
const PHASE_NOTES = {
  off: "risk per trade as typed",
  funded_paid: "scales down only",
  funded_fresh: "flat $225",
  combine: "sized by distance to the trailing floor",
  combine_press: `${usd(PRESS_FLOOR_BUDGET_USD)}, ${usd(PRESS_BUDGET_USD)} when headroom clears the press threshold`,
} satisfies Record<AccountRiskPhase, string>;

// A record keyed by the union, so a phase missing from the select fails to
// compile; key insertion order is the form's order.
const PHASE_OPTIONS: ReadonlyArray<{ phase: AccountRiskPhase; note: string }> = (
  Object.keys(PHASE_NOTES) as AccountRiskPhase[]
).map((phase) => ({ phase, note: PHASE_NOTES[phase] }));

/**
 * The column descriptions. Each was a paragraph standing above the first
 * field until 2026-09-13 and each is carried here verbatim, split on the
 * pivots [copy.md](../../docs/modules/ui/copy.md) asks for. A column the lead
 * sentence already covers gets none rather than a restatement.
 */
const ACCOUNT_DESCRIPTION =
  "Each account shows what kind it is.\n\n" +
  "The platform will not auto-trade every kind. An account it refuses says so and takes no budget.";

const MAX_CONTRACTS_DESCRIPTION =
  `The most contracts one entry may take is capped at ${REVIEWED_MAX_CONTRACTS}.\n\n` +
  "A budget on its own hands the biggest position to the tightest stop, which is the trade " +
  "least able to carry it — so that cap is reviewed against a measured run.\n\n" +
  `Set a lower ceiling on any account here; raising it above ${REVIEWED_MAX_CONTRACTS} takes ` +
  "new evidence, not an edit on this form.";

const DAILY_LIMITS_DESCRIPTION =
  "These stop new entries for the rest of the session once the account's realised P&L reaches " +
  "them. Leave a field empty to turn that side off.\n\n" +
  "They apply to the whole account, so every strategy on it shares one day's budget — which is " +
  "how the broker counts it.\n\n" +
  "A position that is already open is never force-closed; it plays out to its bracket.\n\n" +
  "The session runs 6pm to 4pm ET and the counter resets at the rollover.";

const PHASE_DESCRIPTION =
  "Sets today's risk per trade from yesterday's close and the account's loss limit.\n\n" +
  "Combine: $500 near a new closing high, $350 when $250–750 below it, $225 below that or " +
  "once the limit has locked.\n\n" +
  `Combine, press: ${usd(PRESS_BUDGET_USD)} when the account closed at least the press ` +
  `threshold above its trailing floor, ${usd(PRESS_FLOOR_BUDGET_USD)} otherwise, never lower. ` +
  `Risk per trade caps the press: at ${usd(PRESS_BUDGET_USD)} it presses in full, between ` +
  `${usd(PRESS_FLOOR_BUDGET_USD)} and ${usd(PRESS_BUDGET_USD)} it presses to that number, and at ` +
  `${usd(PRESS_FLOOR_BUDGET_USD)} or less the account is flat at that number.\n\n` +
  "Funded after a payout: never above $225, scaled down as the balance shrinks. A funded " +
  "account cannot be set back to Combine.\n\n" +
  "Risk per trade stays the ceiling in every phase, so an account left on Off risks the number " +
  "you typed and nothing else.\n\n" +
  "On a day with no close on record the account runs the smallest budget its phase allows.";

const MLL_DESCRIPTION =
  "The account's trailing loss limit as the prop firm states it. $2,000 on a 50K.";

const START_BALANCE_DESCRIPTION =
  "The balance the account opened at as the broker reports it. $50,000 on a 50K combine, " +
  "$0 on a funded account.";

/** The starting balance field's tooltip while balances are hidden, when it reads `$xx,xxx.xx` and takes no typing. */
export const START_BALANCE_HIDDEN_TITLE =
  "Balances are hidden. Turn off the $ switch on the Dashboard to see or change it.";

const PRESS_AT_DESCRIPTION =
  `How far above its trailing floor the account must close for the next session to risk ` +
  `${usd(PRESS_BUDGET_USD)} a trade. Below it the account risks ${usd(PRESS_FLOOR_BUDGET_USD)}.`;

/** The two rule parameters describe a phase that reads them; the other two
 *  phases store neither, so the form does not ask for them and Save does not
 *  send them. */
function phaseHasRuleFields(phase: AccountRiskPhase): boolean {
  switch (phase) {
    case "combine":
    case "combine_press":
    case "funded_fresh":
      return true;
    case "off":
    case "funded_paid":
      return false;
    default:
      return unhandledPhase(phase);
  }
}

/** Once a payout is stamped the account can never be a combine or pre-payout
 *  funded again, so these options are blocked on the select rather than
 *  offered and then refused by a save that 400s. */
function phaseBlockedAfterPayout(phase: AccountRiskPhase): boolean {
  switch (phase) {
    case "combine":
    case "combine_press":
    case "funded_fresh":
      return true;
    case "off":
    case "funded_paid":
      return false;
    default:
      return unhandledPhase(phase);
  }
}

/** The close's own day, in the platform's timezone — the sample was taken at
 *  a session close in ET and its calendar day is what the operator remembers. */
const CLOSE_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: TRADING_TIMEZONE,
});

function closeDateLabel(stamp: string | null): string | null {
  if (stamp == null) return null;
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? null : CLOSE_DATE_FORMAT.format(at);
}

/**
 * What today's budget is, and what it was computed from.
 *
 * **A reading nothing acts on has to say so, and this one *is* acted on** —
 * every entry on the account is sized to it — so it states the facts behind
 * the number rather than the number alone ([copy.md](../../docs/modules/ui/copy.md),
 * "A reading nothing acts on has to say so", inverted: the operator must be
 * able to check the arithmetic that will price his next trade).
 *
 * **The reading itself comes from `readAccountRisk`**, which both this block
 * and the board's leg row go through, so neither surface repeats the
 * normalising, the try/catch or the decision about which of the five endings
 * a row is in. The words are this surface's own; the facts are not.
 *
 * Three endings render here, and the last one is why this is not just a
 * formatted number. With a close on record it reads the budget, the headroom,
 * the floor and the day it was sized from. With no usable close the phase runs
 * its **lowest** budget and the line says so in the warning tone, because a
 * budget that is quietly small is read as a decision rather than as a missing
 * sample. And when the resolver *throws* — a busted account, a combine on an
 * MLL nobody measured, a phase on a non-Topstep row — the account takes no
 * order at all, so the throw's own sentence renders in the danger tone rather
 * than being swallowed into a blank line. A phase that is off states nothing:
 * the number is in the field two columns to the left.
 */
function budgetLineOf(
  row: RiskRow,
  now: Date,
  hideBalances: boolean,
): { tone: "muted" | "warning" | "danger"; text: string } | null {
  const reading = readAccountRisk(row, now);
  if (reading.kind === "unset" || reading.kind === "flat") return null;
  // A refusal states a close against its floor or a missing starting balance —
  // balance figures, and no P&L — so every figure in it is masked.
  if (reading.kind === "refused") {
    return { tone: "danger", text: maskUsdFigures(reading.reason, hideBalances) };
  }
  if (reading.kind === "lowest") {
    // Two stale cases, and they are not the same fact: an account the sampler
    // has never reached has no close at all, while one whose stamp is a
    // session old does — a holiday, a missed fan-out — and saying "yet" about
    // it would name a cause nobody checked
    // ([copy.md](../../docs/modules/ui/copy.md), "A line reports what was
    // checked, not what was assumed"). The spec's §8 wording is the first arm.
    return {
      tone: "warning",
      text: `Today's budget ${usd(reading.budgetUsd)} (lowest) · ${
        reading.everSampled ? "no close on record for this session yet" : "no close on record yet"
      }`,
    };
  }
  const day = closeDateLabel(reading.closeStamp);
  // Each clause is appended only when the fact behind it exists — the same
  // rule the day already followed. A headroom and a floor are specific claims
  // and are not invented to keep the line's shape.
  // Headroom over a floor is the balance by addition, so balances hidden masks
  // both; the budget is a risk figure and stays.
  const facts =
    reading.headroomUsd != null && reading.floorUsd != null
      ? maskUsdFigures(` · headroom ${usd(reading.headroomUsd)} · floor ${usd(reading.floorUsd)}`, hideBalances)
      : "";
  // Only when the cap binds — the headroom earned the press rung and the
  // ceiling took it away — so the operator sees the form, not the headroom,
  // set the number. Under the threshold the headroom set it and the line says so.
  const ceiling = row.posture?.maxRiskPerTradeUsd;
  const threshold = row.riskPhase?.pressAtUsd;
  const capped =
    reading.phase === "combine_press" &&
    ceiling != null &&
    threshold != null &&
    reading.headroomUsd != null &&
    toCents(reading.headroomUsd) >= toCents(threshold) &&
    toCents(ceiling) < toCents(PRESS_BUDGET_USD)
      ? ` · risk per trade ${usd(ceiling)} caps the ${usd(PRESS_BUDGET_USD)} press`
      : "";
  return {
    tone: "muted",
    text:
      `Today's budget ${usd(reading.budgetUsd)}${facts}` +
      (day === null ? "" : ` · sized from the close of ${day}`) +
      capped,
  };
}

/** A stored `0` is "off" and renders as an empty field rather than a typed
 *  zero — the same reason an unset posture leaves its fields blank. */
function dollarsDraft(value: number): string {
  return value > 0 ? String(value) : "";
}

/** A typed amount, or `null` for a field the operator left empty — never a
 *  silent `0`, which on a starting balance is a real and very different value.
 *  A field that will not parse serialises to `null` too, and the route answers
 *  its own sentence for both. */
function amountDraft(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * What a trader calls each account class. `PRAC` and `XFA` are the codes the
 * export filename carries, not words anyone says at a desk, and `UNCLASSIFIED`
 * is deliberately not `UNKNOWN` — the operator's question is whether the app
 * has placed this account, and "unclassified" is the answer their reload fixes.
 */
const ACCOUNT_CLASS_LABELS = {
  PRAC: "PRACTICE",
  COMBINE: "COMBINE",
  XFA: "EXPRESS FUNDED",
  LIVE: "LIVE",
  UNKNOWN: "UNCLASSIFIED",
} as const;

/**
 * The identity the class label reads, or `null` when the catalogue row cannot
 * supply one — a row seeded before the `account_name` / `practice` columns has
 * no name or no practice flag, and it labels as unclassified rather than as a
 * guess. The verdict does not come from here; it is the row's `autoTrade`.
 */
function identityOf(row: RiskRow): AccountTradingIdentity | null {
  if (row.name === null || row.practice === null) return null;
  return { name: row.name, broker: row.broker, practice: row.practice };
}

/** The smallest budget the server accepts: the rule is "more than $0" and the
 *  field steps in cents, so `min={0}` on the spinner offered a value the save
 *  then refused. */
const MIN_RISK_USD = 0.01;

/** How long a Clear stays armed before it disarms itself, matching the board's
 *  two-step confirm. The Books page's *Remove from account* reads it too. */
export const ARM_MS = 4000;

/** How often the read-only budget line re-checks the clock. Without this an
 *  open tab freezes at whatever instant it mounted, so a session's budget
 *  line still reads today's headroom well past the 18:00 ET roll that makes
 *  its close stale. */
const BUDGET_LINE_TICK_MS = 60_000;

/** Column headers: uppercase, label-tier, with tracking — the rule no table
 *  in this app gets a pass on. */
const TH =
  "text-left font-normal text-[10px] uppercase tracking-wider text-[var(--muted)] px-2 py-1.5 align-bottom whitespace-nowrap";

const TD = "block lg:table-cell px-2 py-2 align-top";
/**
 * Below `lg` the table stops being a table: the header row hides, each
 * account's settings wrap as labelled fields, and nothing scrolls sideways.
 * These are the pieces that switch; the labels repeat what the hidden header
 * says, so they render only while it is hidden.
 */
const TABLE = "block lg:table w-full border-collapse";
const THEAD = "hidden lg:table-header-group";
const TBODY = "block lg:table-row-group";
const ROW = "block lg:table-row";
/** Below `sm` a two-column grid: risk and contracts share a line, the daily
 *  limits the next, then the phase and the actions full width. */
const SETTINGS_ROW = "grid grid-cols-2 items-start gap-x-2 sm:flex sm:flex-wrap lg:table-row";
/** A field that takes a whole line of the phone grid, and only on a phone. */
const PHONE_FULL_LINE = "col-span-2 sm:col-span-1";
const SPAN_CELL = "block lg:table-cell px-2 align-top";
/** The settings columns: risk, contracts, daily limits, phase, actions. */
const COLUMN_COUNT = 5;

/** `min-h-11` below `sm` is a thumb target; desk height from `sm`. */
const FIELD =
  "font-mono tabular text-xs px-2 py-1 min-h-11 sm:min-h-0 rounded-md bg-[var(--background)] border border-[var(--card-border)]";

/** The two sides of the daily gate share one column, so each input carries a
 *  word of its own inside it. 10px uppercase is the structural-stamp scale,
 *  which is what this is. */
const SUB_LABEL = "text-[10px] uppercase tracking-wider text-[var(--muted)]";
const MOBILE_LABEL = `${SUB_LABEL} block mb-1 lg:hidden`;

/** The list is empty because every catalogued account was left out, not
 *  because there are none. */
const NO_OPEN_ACCOUNTS =
  "None of your accounts can trade right now. Closed and failed accounts leave this list once " +
  "your broker reports them, and their trade history is kept.";

/** The stamp on a row whose broker reports it dead but which still carries a
 *  risk per trade — listed so the operator can clear it. */
export const CLOSED_AT_BROKER_STAMP = "closed at broker";

const CLOSED_AT_BROKER_TITLE =
  "Your broker says this account can no longer trade — it failed a rule or was closed. " +
  "Clear its risk setting to take it off this list.";

/** The stamp on a row its broker has locked out for now. It stays listed and
 *  editable: a lockout ends. */
export const LOCKED_AT_BROKER_STAMP = "locked";

/** The lockout's end, in the platform's timezone, to the minute. */
const LOCKOUT_UNTIL_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: TRADING_TIMEZONE,
});

/** Whether a row reads as locked at `now`. The stored status is the last
 *  check's, so a lock whose end has since passed is shown as over; one with no
 *  readable end stays locked. */
export function lockedAt(
  status: { state: string | null; lockoutUntil?: string | null } | null | undefined,
  now: Date,
): boolean {
  if (status?.state !== "locked") return false;
  const until = status.lockoutUntil == null ? NaN : Date.parse(status.lockoutUntil);
  return Number.isNaN(until) || until > now.getTime();
}

/** The second-line sentence for a locked row: who locked it, until when, and
 *  why, saying plainly when the broker gave no end time. */
export function lockoutLine(
  brokerName: string,
  lockoutReason: string | null | undefined,
  lockoutUntil: string | null | undefined,
): string {
  const until = lockoutUntil == null ? null : new Date(lockoutUntil);
  const when =
    until !== null && !Number.isNaN(until.getTime())
      ? ` until ${LOCKOUT_UNTIL_FORMAT.format(until)} ET`
      : null;
  const reason = lockoutReason?.trim() ? ` (${lockoutReason.trim()})` : "";
  return when !== null
    ? `${brokerName} has locked this account${when}${reason}.`
    : `${brokerName} has locked this account${reason} and gave no end time.`;
}

/** What the open-time status check is doing, in one line under the lead.
 *  Silent once it has answered cleanly — the list itself is the answer. */
function StatusCheckLine({ check }: { check: AccountStatusCheckState }) {
  switch (check.kind) {
    case "idle":
      return null;
    case "checking":
      return (
        <p className="text-[11px] text-[var(--muted)]">
          Checking with your broker which accounts are still open…
        </p>
      );
    case "done": {
      if (check.failed.length === 0) return null;
      const names = check.failed.map((b) => BROKER_NAMES[b] ?? b).join(" and ");
      return (
        <p className="text-[11px] text-[var(--warning)]">
          {names} did not answer, so {check.failed.length === 1 ? "its" : "their"} accounts are
          listed as of the last check.
        </p>
      );
    }
    case "error":
      return (
        <p className="text-[11px] text-[var(--warning)]">
          Could not check which accounts are still open ({check.message}). Accounts are listed as
          of the last check.
        </p>
      );
  }
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

/**
 * The response's `accounts` array, or null when the body carries no array
 * there.
 *
 * **The element type is asserted, not checked.** What this buys is the
 * distinction between "the server answered a list" and "the server answered
 * something else" — a stub, a proxy or a rewritten route hands back a body
 * with no `accounts` at all, and an `undefined` reaching `rows` renders as
 * neither "loading" nor "no accounts". It is not a validator: a row missing
 * `posture` would still get through. Every field this reads is optional or
 * null-guarded at the render site, so the residual is a blank row rather than
 * a throw. **`autoTrade` is the exception, narrowed through `toVerdict`**:
 * it gates the form, so a missing or malformed verdict (`permitted: 1`)
 * reads as the unverified refusal rather than as permitted.
 */
function accountsOf(body: unknown): RiskRow[] | null {
  if (typeof body !== "object" || body === null) return null;
  const accounts = (body as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return null;
  return accounts
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({ ...(r as unknown as RiskRow), autoTrade: toVerdict(r.autoTrade) }));
}

export function AccountRiskBlock({
  token,
  statusCheck = STATUS_CHECK_IDLE,
}: {
  token: string;
  statusCheck?: AccountStatusCheckState;
}) {
  const [rows, setRows] = useState<RiskRow[] | null>(null);
  // How many catalogued accounts the list left out, so an empty list can say
  // whether there are no accounts at all or none that can still trade.
  const [hiddenCount, setHiddenCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, RiskDraft>>({});
  const [save, setSave] = useState<Record<number, SaveState>>({});
  // One account at a time: arming a second Clear disarms the first, which is
  // the honest reading of a confirm step — the operator is answering about one
  // row. Null is "nothing armed".
  const [clearArmed, setClearArmed] = useState<number | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fed to `budgetLineOf` instead of a bare `new Date()` at render, so a tab
  // left open re-evaluates which session a close is stamped for as the clock
  // crosses the roll — see `BUDGET_LINE_TICK_MS`.
  const [now, setNow] = useState(() => new Date());
  const { hideAccountIds, hideBalances, accountLabel } = useDisplayPrivacy();

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), BUDGET_LINE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const applyRows = useCallback((all: RiskRow[], opts: { keepDrafts?: boolean } = {}) => {
    const production = isProductionEnv();
    const next = all.filter((r) => listedOnRisk(r, { production }));
    setRows(next);
    setHiddenCount(all.length - next.length);
    // Seed the inputs from what is stored, and leave an unset posture's
    // fields empty rather than pre-filling a number nobody chose — the empty
    // field and the "not set" stamp say the same thing twice, on purpose.
    // A re-read after the status check keeps what the operator has typed: it
    // can land while a row is half filled in.
    const seeded: Record<number, RiskDraft> = Object.fromEntries(
      next.map((r) => [
        r.accountId,
        {
          risk: r.posture == null ? "" : String(r.posture.maxRiskPerTradeUsd),
          contracts: r.posture == null ? "" : String(r.posture.maxContracts),
          // Optional-chained for the reason `accountsOf`'s doc gives: the
          // element type is asserted rather than checked, so a body missing
          // this object must render a blank field, not throw.
          dailyLoss: dollarsDraft(r.dailyPnl?.dailyMaxLossUsd ?? 0),
          dailyProfit: dollarsDraft(r.dailyPnl?.dailyMaxProfitUsd ?? 0),
          phase: r.riskPhase?.phase ?? "off",
          // Not `dollarsDraft`: a funded account really does start at $0, so
          // a stored zero here is a value the operator typed rather than an
          // off switch.
          mll: r.riskPhase?.mllUsd == null ? "" : String(r.riskPhase.mllUsd),
          startBalance:
            r.riskPhase?.startBalanceUsd == null ? "" : String(r.riskPhase.startBalanceUsd),
          pressAt: r.riskPhase?.pressAtUsd == null ? "" : String(r.riskPhase.pressAtUsd),
          fromTopstep: [],
        },
      ]),
    );
    // Topstep's suggestions go in last, onto whatever is empty — after a save
    // that is what the save left empty, after the status check it is what the
    // operator has not typed into, refreshed from the record the check wrote.
    setDrafts((prev) => {
      const out: Record<number, RiskDraft> = {};
      for (const r of next) {
        const base = opts.keepDrafts ? (prev[r.accountId] ?? seeded[r.accountId]) : seeded[r.accountId];
        out[r.accountId] = withPrefill(base, r);
      }
      return out;
    });
  }, []);

  // The list is read on mount and again when the open-time status check
  // settles, because that check is what decides which rows are listed.
  const statusSettled = statusCheck.kind === "done" || statusCheck.kind === "error";
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/accounts/risk");
        if (!res.ok) throw new Error(`Request failed (${res.status}).`);
        const rowsIn = accountsOf(await res.json());
        if (rowsIn == null) throw new Error("The server did not return an account list.");
        if (!cancelled) {
          setLoadError(null);
          applyRows(rowsIn, { keepDrafts: loadedRef.current });
          loadedRef.current = true;
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, applyRows, statusSettled]);

  async function submit(accountId: number, body: Record<string, unknown>) {
    setSave((prev) => ({ ...prev, [accountId]: { kind: "saving" } }));
    try {
      const res = await fetch("/api/accounts/risk", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, ...body }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Save failed (${res.status}).`;
        throw new Error(message);
      }
      const rowsIn = accountsOf(data);
      if (rowsIn != null) applyRows(rowsIn);
      setSave((prev) => ({ ...prev, [accountId]: { kind: "saved", at: Date.now() } }));
    } catch (err) {
      setSave((prev) => ({
        ...prev,
        [accountId]: { kind: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  /** Two-step confirm, the same shape the board's ✕ uses: Clear disarms the
   *  account, and an account with no posture takes no trades. */
  function onClear(accountId: number) {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    if (clearArmed !== accountId) {
      setClearArmed(accountId);
      armTimerRef.current = setTimeout(() => setClearArmed(null), ARM_MS);
      return;
    }
    armTimerRef.current = null;
    setClearArmed(null);
    void submit(accountId, {});
  }

  function onSave(row: RiskRow) {
    // A disabled field is one devtools keystroke from gone and a stale render
    // can hand a click to a row the current props would block, so the handler
    // repeats the row's own check with the same operands. Clear has no such
    // guard on purpose: disarming a refused account is the wind-down
    // direction, the same carve-out the leg picker's `&& !checked` makes.
    if (!accountAutoTrade(row).permitted) return;
    const draft = drafts[row.accountId] ?? EMPTY_DRAFT;
    const risk = Number(draft.risk.trim());
    const contracts = Number(draft.contracts.trim());
    // Refused at the field rather than by a save that fails: the server
    // checks the same two things, and being told after a round trip is
    // strictly worse on a form the operator is filling in.
    if (draft.risk.trim() === "" || !Number.isFinite(risk) || risk <= 0) {
      setSave((prev) => ({
        ...prev,
        [row.accountId]: { kind: "error", message: "Risk per trade must be more than $0." },
      }));
      return;
    }
    if (draft.contracts.trim() === "" || !Number.isInteger(contracts) || contracts < 1) {
      setSave((prev) => ({
        ...prev,
        [row.accountId]: {
          kind: "error",
          message: "Maximum contracts must be a whole number, at least 1.",
        },
      }));
      return;
    }
    // The reviewed ceiling, refused at the field with the server's own sentence
    // rather than a second wording of it — a number typed above it is a save
    // that cannot succeed on any account.
    if (contracts > REVIEWED_MAX_CONTRACTS) {
      setSave((prev) => ({
        ...prev,
        [row.accountId]: { kind: "error", message: MAX_CONTRACTS_REFUSAL },
      }));
      return;
    }
    // An empty daily field is "off", which the server reads as 0 — a blank is
    // not a validation failure here, unlike the two above.
    const dailyLoss = draft.dailyLoss.trim() === "" ? 0 : Number(draft.dailyLoss.trim());
    const dailyProfit = draft.dailyProfit.trim() === "" ? 0 : Number(draft.dailyProfit.trim());
    for (const [value, label] of [
      [dailyLoss, "Daily loss limit"],
      [dailyProfit, "Daily profit limit"],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        setSave((prev) => ({
          ...prev,
          [row.accountId]: { kind: "error", message: `${label} must be $0 or more. 0 turns it off.` },
        }));
        return;
      }
    }
    // The buckets were measured on the 50K's $2,000 limit alone, so a combine
    // on any other number is a save that cannot succeed — refused here with
    // the route's own sentence rather than a second wording of it.
    const mll = amountDraft(draft.mll);
    const startBalance = amountDraft(draft.startBalance);
    if (isCombinePhase(draft.phase) && mll !== COMBINE_MLL_USD) {
      setSave((prev) => ({
        ...prev,
        [row.accountId]: { kind: "error", message: COMBINE_MLL_REFUSAL },
      }));
      return;
    }
    void submit(row.accountId, {
      maxRiskPerTradeUsd: risk,
      maxContracts: contracts,
      dailyMaxLossUsd: dailyLoss,
      dailyMaxProfitUsd: dailyProfit,
      riskPhase: draft.phase,
      // The other two phases store neither, so naming them would be sending a
      // number the account does not have.
      ...(phaseHasRuleFields(draft.phase) ? { mllUsd: mll, startBalanceUsd: startBalance } : {}),
      ...(draft.phase === "combine_press" ? { pressAtUsd: amountDraft(draft.pressAt) } : {}),
    });
  }

  return (
    // Untitled: the Risk page's section header names it.
    <section className="border border-[var(--card-border)] bg-[var(--card)]">
      <div className="px-4 py-3 border-b border-[var(--card-border)] space-y-1">
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">
          How much one trade on each account may lose at its stop, fees included. Every entry is
          sized to the largest number of contracts that fits — an entry whose stop is too wide for
          one contract is skipped, and a later setup with a tighter stop still trades.{" "}
          <span className="text-[var(--foreground)]">
            An account with no risk set here takes no trades.
          </span>
        </p>
        <StatusCheckLine check={statusCheck} />
      </div>

      {/* Three states, three sentences, and they are not interchangeable: a
          read still out, a read that failed, and a catalogue that is genuinely
          empty. The last one says where the rows would have come from, because
          an empty list otherwise reads as "there are none and there never will
          be". */}
      {loadError !== null && (
        <p className="px-4 py-3 text-[11px] text-[var(--danger)]">
          Could not load accounts: {loadError}
        </p>
      )}

      {rows === null && loadError === null && (
        <p className="px-4 py-3 text-[11px] text-[var(--muted)]">Loading accounts…</p>
      )}

      {rows !== null && rows.length === 0 && hiddenCount === 0 && (
        <p className="px-4 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
          No accounts yet. Open the Dashboard once a broker is connected — that is what tells this
          app which accounts you have.
        </p>
      )}

      {rows !== null && rows.length === 0 && hiddenCount > 0 && (
        <p className="px-4 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
          {NO_OPEN_ACCOUNTS}
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <div>
          <table className={TABLE}>
            <thead className={THEAD}>
              {/* The account is not a column: it heads its own band, so its
                  name and stamps take a line of their own and the five
                  settings fit the row without a horizontal scroll. */}
              <tr className="border-b border-[var(--card-border)]">
                <th className={TH}>Risk per trade ($)</th>
                <th className={TH}>
                  <span className="inline-flex items-center gap-1">
                    Max contracts
                    <InfoIcon description={MAX_CONTRACTS_DESCRIPTION} />
                  </span>
                </th>
                <th className={TH}>
                  <span className="inline-flex items-center gap-1">
                    Daily limits ($)
                    <InfoIcon description={DAILY_LIMITS_DESCRIPTION} />
                  </span>
                </th>
                <th className={TH}>
                  <span className="inline-flex items-center gap-1">
                    Account phase
                    <InfoIcon description={PHASE_DESCRIPTION} />
                  </span>
                </th>
                {/* The action cluster anchors far right and needs no word over
                    it; the header cell still exists so the column is a column. */}
                <th className={`${TH} text-right`}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>

            {rows.map((row, index) => {
              const draft = drafts[row.accountId] ?? EMPTY_DRAFT;
              const state = save[row.accountId] ?? { kind: "idle" };
              const identity = identityOf(row);
              const verdict = accountAutoTrade(row);
              const classLabel =
                ACCOUNT_CLASS_LABELS[identity ? classifyAccount(identity) : "UNKNOWN"];
              // A phase other than Off is refused on a non-Topstep row — the
              // rule model is Topstep's — so the select offers the one setting
              // that can be saved rather than three that answer a refusal.
              const phaseOptions =
                row.broker === "topstep"
                  ? PHASE_OPTIONS
                  : PHASE_OPTIONS.filter((o) => o.phase === "off");
              const postPayout = row.riskPhase?.payoutTakenAt != null;
              const budgetLine = budgetLineOf(row, now, hideBalances);
              // By id, not name: a row seeded before the name column has none,
              // and its `Account <id>` fallback would mask to `Account ?`.
              const alias = hideAccountIds ? accountLabel(row.accountId) : null;
              const heading = alias ?? row.name ?? `Account ${row.accountId}`;
              const ariaName = alias ?? row.name ?? `account ${row.accountId}`;
              const phaseFieldId = `account-phase-${row.accountId}`;
              // A row re-tagged Tradovate keeps whatever phase it last saved as
              // Topstep, but `phaseOptions` above offers only Off — rendering
              // `draft.phase` verbatim would hand the select a value with no
              // matching option (`selectedIndex` -1). The draft itself is left
              // alone so a row moved back to Topstep still shows what it had.
              const selectValue = row.broker === "topstep" ? draft.phase : "off";
              const dim = verdict.permitted ? "" : "opacity-50";
              const ruleFields = phaseHasRuleFields(draft.phase);
              // The second line exists only when it has something to say. A
              // row with a permitted account, no phase and no save in flight
              // is one line, which is the common case and the point of the
              // split.
              const locked = lockedAt(row.status, now);
              // Topstep's own program limit, said beside the operator's gate
              // and never copied into it: the broker enforces its own.
              const brokerDailyLoss = riskPrefillOf(row.brokerFacts).brokerDailyLossUsd;
              const hasDetail =
                !verdict.permitted ||
                locked ||
                brokerDailyLoss !== null ||
                ruleFields ||
                budgetLine !== null ||
                state.kind !== "idle";
              // The band is on the rows rather than on the `<tbody>`, because
              // an account is one band whether it renders one line or two and
              // a group background under `border-collapse` is the less
              // dependable of the two paints.
              const zebra = index % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]";

              return (
                <tbody key={row.accountId} className={TBODY}>
                  <tr className={`${ROW} ${zebra}`}>
                    <td className={`${SPAN_CELL} pt-2`} colSpan={COLUMN_COUNT}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1 font-mono text-xs text-[var(--foreground)]">
                          {heading}
                          <InfoIcon description={ACCOUNT_DESCRIPTION} />
                        </span>
                        <span className="flex flex-wrap items-center gap-1">
                          <FieldBadge label={row.broker === "tradovate" ? "TRADOVATE" : "TOPSTEP"} />
                          <FieldBadge label={classLabel} />
                          {/* Same words and tone as the leg picker's stamp and
                              the deployment status chip: one rule, one
                              wording. */}
                          {!verdict.permitted && (
                            <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-full border bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30">
                              no auto-trade
                            </span>
                          )}
                          {row.posture === null && (
                            <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-full border bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30">
                              {RISK_NOT_SET_STAMP}
                            </span>
                          )}
                          {/* Listed only because it still carries a risk per
                              trade; Clear takes it off the list. */}
                          {row.status?.state === "dead" && (
                            <span
                              title={CLOSED_AT_BROKER_TITLE}
                              className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-full border bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30"
                            >
                              {CLOSED_AT_BROKER_STAMP}
                            </span>
                          )}
                          {locked && (
                            <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-full border bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30">
                              {LOCKED_AT_BROKER_STAMP}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                  </tr>

                  <tr className={`${SETTINGS_ROW} ${zebra}`}>
                    <td className={`${TD} ${dim}`}>
                      <span className={MOBILE_LABEL}>Risk per trade ($)</span>
                      <input
                        type="number"
                        min={MIN_RISK_USD}
                        step="0.01"
                        aria-label={`Risk per trade for ${ariaName}`}
                        disabled={!verdict.permitted}
                        value={draft.risk}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [row.accountId]: { ...draft, risk: e.target.value },
                          }))
                        }
                        className={`${FIELD} w-full sm:w-24`}
                      />
                    </td>

                    <td className={`${TD} ${dim}`}>
                      <span className={MOBILE_LABEL}>Max contracts</span>
                      <input
                        type="number"
                        min={1}
                        max={REVIEWED_MAX_CONTRACTS}
                        step={1}
                        aria-label={`Max contracts for ${ariaName}`}
                        disabled={!verdict.permitted}
                        value={draft.contracts}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [row.accountId]: { ...draft, contracts: e.target.value },
                          }))
                        }
                        className={`${FIELD} w-full sm:w-16`}
                      />
                    </td>

                    {/* One gate, two sides, one column. The header names the
                        set; these two words name the members. */}
                    <td className={`${TD} ${dim} ${PHONE_FULL_LINE}`}>
                      <span className={MOBILE_LABEL}>Daily limits ($)</span>
                      <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
                        <label className="flex items-center gap-1">
                          <span className={SUB_LABEL}>Loss</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="off"
                            disabled={!verdict.permitted}
                            value={draft.dailyLoss}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [row.accountId]: edited(draft, "dailyLoss", { dailyLoss: e.target.value }),
                              }))
                            }
                            className={`${FIELD} w-full min-w-0 sm:w-20 sm:min-w-auto`}
                          />
                          {draft.fromTopstep.includes("dailyLoss") && (
                            <FieldBadge label={FROM_TOPSTEP_BADGE} />
                          )}
                        </label>
                        <label className="flex items-center gap-1">
                          <span className={SUB_LABEL}>Profit</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="off"
                            disabled={!verdict.permitted}
                            value={draft.dailyProfit}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [row.accountId]: { ...draft, dailyProfit: e.target.value },
                              }))
                            }
                            className={`${FIELD} w-full min-w-0 sm:w-20 sm:min-w-auto`}
                          />
                        </label>
                      </div>
                    </td>

                    <td className={`${TD} ${dim} max-w-full ${PHONE_FULL_LINE}`}>
                      <label htmlFor={phaseFieldId} className={MOBILE_LABEL}>
                        Account phase
                      </label>
                      <select
                        id={phaseFieldId}
                        aria-label={`Account phase for ${ariaName}`}
                        disabled={!verdict.permitted}
                        value={selectValue}
                        title={
                          row.broker !== "topstep"
                            ? NON_TOPSTEP_PHASE_REFUSAL
                            : verdict.permitted
                              ? undefined
                              : verdict.reason
                        }
                        onChange={(e) => {
                          const next = e.target.value;
                          if (!isAccountRiskPhase(next)) return;
                          // An empty threshold takes the sim's number on first
                          // selection; one the operator typed is kept.
                          const pressAt =
                            next === "combine_press" && draft.pressAt.trim() === ""
                              ? String(PRESS_AT_SUGGESTED_USD)
                              : draft.pressAt;
                          setDrafts((prev) => ({
                            ...prev,
                            [row.accountId]: edited(draft, "phase", { phase: next, pressAt }),
                          }));
                        }}
                        className="w-full sm:w-56 max-w-full min-h-11 sm:min-h-0 text-xs px-2 py-1 rounded-md bg-[var(--background)] border border-[var(--card-border)]"
                      >
                        {phaseOptions.map((option) => (
                          <option
                            key={option.phase}
                            value={option.phase}
                            // Once a payout is stamped the account can never be
                            // a combine or pre-payout funded again, so the two
                            // options carry the rule rather than a save that
                            // 400s.
                            disabled={postPayout && phaseBlockedAfterPayout(option.phase)}
                            title={
                              postPayout && phaseBlockedAfterPayout(option.phase)
                                ? POST_PAYOUT_PHASE_REFUSAL
                                : undefined
                            }
                          >
                            {`${ACCOUNT_RISK_PHASE_LABELS[option.phase]} — ${option.note}`}
                          </option>
                        ))}
                      </select>
                      {draft.fromTopstep.includes("phase") && (
                        <div className="mt-1">
                          <FieldBadge label={FROM_TOPSTEP_BADGE} />
                        </div>
                      )}
                    </td>

                    {/* Far right, the way every primary action on this app
                        anchors. The dim lands on Save and never on Clear:
                        clearing a refused account that already carries a
                        budget is the wind-down direction, and an enabled
                        control at half opacity reads as dead. */}
                    {/* On a phone the pair takes its own line, Save filling
                        it beside Clear at its natural width. */}
                    <td
                      className={`${TD} ${PHONE_FULL_LINE} text-right whitespace-nowrap self-end sm:ml-auto lg:ml-0`}
                    >
                      <span className="flex w-full items-center gap-2 sm:inline-flex sm:w-auto">
                        {row.posture !== null && (
                          <button
                            type="button"
                            onClick={() => onClear(row.accountId)}
                            disabled={state.kind === "saving"}
                            className={`min-h-11 text-xs px-3 py-1 rounded-md border disabled:opacity-50 sm:min-h-0 ${
                              clearArmed === row.accountId
                                ? "border-[var(--danger)] bg-[var(--danger)]/15 text-[var(--danger)]"
                                : "border-[var(--card-border)] text-[var(--muted)] hover:bg-[var(--hover)]"
                            }`}
                            title={
                              clearArmed === row.accountId
                                ? "Click again to clear the risk setting. This account stops taking trades."
                                : "Clear the risk setting. This account stops taking trades."
                            }
                          >
                            {clearArmed === row.accountId ? "Confirm?" : "Clear"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onSave(row)}
                          disabled={state.kind === "saving" || !verdict.permitted}
                          title={verdict.permitted ? undefined : verdict.reason}
                          className="min-h-11 flex-1 text-xs px-3 py-1 rounded-md border border-[var(--card-border)] hover:bg-[var(--hover)] disabled:opacity-50 sm:min-h-0 sm:flex-initial"
                        >
                          {state.kind === "saving" ? "Saving…" : "Save"}
                        </button>
                      </span>
                    </td>
                  </tr>

                  {hasDetail && (
                    <tr className={`${ROW} ${zebra}`}>
                      <td className={`${SPAN_CELL} pb-2`} colSpan={COLUMN_COUNT}>
                        <div className="space-y-1.5">
                          {/* The reason sentence verbatim from the policy's own
                              constant, as a line rather than a tooltip: a
                              budget typed into a refused account is a dead end,
                              and the operator has to be able to read why
                              without hovering. It is not dimmed with the
                              controls above — the explanation is the one part
                              of a refused row that must stay legible. */}
                          {!verdict.permitted && (
                            <p className="text-[11px] leading-relaxed text-[var(--danger)]">
                              {verdict.reason}
                            </p>
                          )}

                          {/* The broker's lock, said rather than inferred: the
                              row stays editable, because what the engine may
                              trade is not decided here. */}
                          {locked && (
                            <p className="text-[11px] font-mono tabular leading-relaxed text-[var(--warning)]">
                              {lockoutLine(
                                BROKER_NAMES[row.broker] ?? row.broker,
                                row.status?.lockoutReason,
                                row.status?.lockoutUntil,
                              )}
                            </p>
                          )}

                          {brokerDailyLoss !== null && (
                            <p className="text-[11px] font-mono tabular leading-relaxed text-[var(--muted)]">
                              {topstepDailyLossLine(brokerDailyLoss)}
                            </p>
                          )}

                          {/* The phase's own rule parameters, on the row's
                              second line because they belong to a declaration
                              the column above states. Rendered for the phases
                              that read them and for no others — the
                              boolean-gating convention, not disclosure. */}
                          {ruleFields && (
                            <div className={`flex flex-wrap items-center gap-4 ${dim}`}>
                              {/* A `<span>` and a `htmlFor`, never a `<label>`
                                  wrapping the pair: the InfoIcon is a button,
                                  and a button inside a label hands its click to
                                  the field as well as to itself. */}
                              <span className="flex items-center gap-1.5">
                                <label
                                  htmlFor={`account-mll-${row.accountId}`}
                                  className={SUB_LABEL}
                                >
                                  Maximum loss limit ($)
                                </label>
                                <InfoIcon description={MLL_DESCRIPTION} />
                                <input
                                  id={`account-mll-${row.accountId}`}
                                  type="number"
                                  min={MIN_RISK_USD}
                                  step="0.01"
                                  disabled={!verdict.permitted}
                                  value={draft.mll}
                                  onChange={(e) =>
                                    setDrafts((prev) => ({
                                      ...prev,
                                      [row.accountId]: edited(draft, "mll", { mll: e.target.value }),
                                    }))
                                  }
                                  className={`${FIELD} w-24`}
                                />
                                {draft.fromTopstep.includes("mll") && (
                                  <FieldBadge label={FROM_TOPSTEP_BADGE} />
                                )}
                              </span>
                              <span className="flex items-center gap-1.5">
                                <label
                                  htmlFor={`account-start-balance-${row.accountId}`}
                                  className={SUB_LABEL}
                                >
                                  Starting balance ($)
                                </label>
                                <InfoIcon description={START_BALANCE_DESCRIPTION} />
                                {/* Read-only rather than blank while hidden: the
                                    draft keeps the stored figure, so Save still
                                    sends it unchanged. */}
                                {hideBalances ? (
                                  <input
                                    id={`account-start-balance-${row.accountId}`}
                                    type="text"
                                    readOnly
                                    value={MASKED_USD}
                                    title={START_BALANCE_HIDDEN_TITLE}
                                    className={`${FIELD} w-28`}
                                  />
                                ) : (
                                  <input
                                    id={`account-start-balance-${row.accountId}`}
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    disabled={!verdict.permitted}
                                    value={draft.startBalance}
                                    onChange={(e) =>
                                      setDrafts((prev) => ({
                                        ...prev,
                                        [row.accountId]: edited(draft, "startBalance", {
                                          startBalance: e.target.value,
                                        }),
                                      }))
                                    }
                                    className={`${FIELD} w-28`}
                                  />
                                )}
                                {draft.fromTopstep.includes("startBalance") && (
                                  <FieldBadge label={FROM_TOPSTEP_BADGE} />
                                )}
                              </span>
                              {draft.phase === "combine_press" && (
                                <span className="flex items-center gap-1.5">
                                  <label
                                    htmlFor={`account-press-at-${row.accountId}`}
                                    className={SUB_LABEL}
                                  >
                                    Press threshold ($)
                                  </label>
                                  <InfoIcon description={PRESS_AT_DESCRIPTION} />
                                  <input
                                    id={`account-press-at-${row.accountId}`}
                                    type="number"
                                    min={MIN_RISK_USD}
                                    step="0.01"
                                    disabled={!verdict.permitted}
                                    value={draft.pressAt}
                                    onChange={(e) =>
                                      setDrafts((prev) => ({
                                        ...prev,
                                        [row.accountId]: { ...draft, pressAt: e.target.value },
                                      }))
                                    }
                                    className={`${FIELD} w-24`}
                                  />
                                </span>
                              )}
                            </div>
                          )}

                          {/* What the phase resolves to for the session in
                              progress, computed by the same pure reader the
                              board's leg row uses and the same resolver the
                              engine calls — not a second arithmetic. The
                              warning tone is the "not set" stamp's: a budget
                              the account fell back to is a state to fix, not a
                              setting. */}
                          {budgetLine !== null && (
                            <p
                              className={`text-[11px] font-mono tabular leading-relaxed ${
                                budgetLine.tone === "danger"
                                  ? "text-[var(--danger)]"
                                  : budgetLine.tone === "warning"
                                    ? "text-[var(--warning)]"
                                    : "text-[var(--muted)]"
                              }`}
                            >
                              {budgetLine.text}
                            </p>
                          )}

                          {state.kind === "error" && (
                            <p className="text-[11px] text-[var(--danger)]">{state.message}</p>
                          )}
                          {state.kind === "saved" && (
                            <p className="text-[11px] text-[var(--success)]">Saved.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </section>
  );
}
