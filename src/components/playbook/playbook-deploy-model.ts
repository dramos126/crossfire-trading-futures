/**
 * The Deploy control on `/playbooks/[key]` — the pure half.
 *
 * Twelfth pure module on the `deployment-status.ts` / `board-model.ts` /
 * `book-grid-model.ts` pattern, and here for the same reason: a Deploy button
 * that is live on a playbook naming no instrument, an account row that hides a
 * refusal instead of stating it, a notice that says a book's copy stands down
 * when the route is about to refuse this one — each is one ternary in a
 * component, and none of them shows in a screenshot.
 *
 * **One choice, an account.** A playbook's numbers are fixed in code, so the
 * request carries the module's own defaults and nothing the operator typed;
 * the instrument is the one it was calibrated for; the size is the account's
 * risk posture, resolved per entry by the sizer. There is no form to render.
 *
 * **No second predicate.** The account rows read the server's auto-trade
 * verdict off each `/api/accounts` row (`AccountRow.autoTrade`), as
 * `account-leg-picker.tsx` does through this module, and read the account-state
 * gate off the server's `GET /api/books` answer; the create goes through
 * `POST /api/deployments`, where the live-account block, the instrument
 * refusal and the day-session refusal all already run. The conflict questions
 * this module reads are the server's own answer from
 * `POST /api/deployments/conflict-check`; nothing here re-derives which
 * deployment holds a slot or shares a contract.
 */

import type { BookPayload } from "@/app/api/books/route";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import type { AccountRow } from "@/lib/hooks/use-trading/account-row";
import type { DeploymentsLoadState } from "@/lib/hooks/use-strategies";
import { TICKER_OPTIONS, type TickerSymbol } from "@/lib/trading/domain";
import {
  daySessionRefusalFor,
  defaultParamValues,
  type ParamValues,
  type StrategyModule,
  undeployableInstrumentRefusal,
} from "@/lib/trading/strategy-types";

// ── Copy ────────────────────────────────────────────────────────────────

/**
 * Why Deploy is inert on a playbook that names no instrument.
 *
 * **Fail closed, and never ask.** A playbook's instrument is part of what was
 * measured, so a ticker the operator picks here would be a combination nobody
 * measured — the thing the instrument refusal exists to stop. The sentence
 * names the one fix, which is in code rather than on this screen.
 */
export const NO_CALIBRATED_INSTRUMENT_REASON =
  "This playbook does not name the instrument it was calibrated for, so there is nothing to " +
  "deploy it on. That is declared in the playbook's code; the platform will not guess one.";

/** The frame's `InfoIcon`. Split on `\n\n` per the tooltip rule. */
export const DEPLOY_HELP =
  "Runs this playbook on one account. Its numbers are fixed in code, it trades the instrument " +
  "it was calibrated for, and each entry is sized from that account's risk settings — there " +
  "is nothing else to set.\n\n" +
  "This is how a playbook runs outside a book, including one still being tested. A book runs " +
  "the vetted ones together on an account.";

export const DEPLOY_PICK_ACCOUNT = "Pick an account.";

/** Deploy waits for the open's account-status check, which is what says
 *  whether an account is dead, locked or has OCO off. */
export const DEPLOY_CHECKING_ACCOUNTS = "Checking the accounts with the broker…";

/** The empty picker, which is two different facts. */
export function describeNoAccounts(practiceOnly: boolean): string {
  return practiceOnly
    ? "No practice accounts are visible. Turn Practice-only off, or connect a practice account."
    : "No accounts are connected.";
}

/** A request that never landed, before anything was created. */
export const DEPLOY_UNREACHABLE =
  "The deploy request never reached the server. Nothing was created.";

/** A request that stopped answering after the create landed — so the
 *  unreachable sentence, which says nothing was created, would be false. */
export const DEPLOY_INTERRUPTED = "The deploy stopped partway, after the deployment was created.";

/** The rollback after a failed engine start, when it landed. */
export const DEPLOY_ROLLED_BACK = "The deployment it created was deleted.";

/**
 * The rollback did not land. The row is `Active` in the database and the
 * engine picks it up the next time it reads the deployment set, so saying
 * only *"engine start failed"* would leave the operator believing nothing
 * runs. The delete control is on the row's Dashboard card.
 */
export const DEPLOY_ROLLBACK_FAILED =
  "The deployment it created could not be deleted and is still Active. Delete it from its " +
  "card on the Dashboard before the engine picks it up.";

/**
 * Why Deploy waits for the deployment list. Whether the press starts the
 * engine or updates it is read off that list, and a start on an engine that is
 * already running does nothing — so a press on an unanswered list can create
 * an Active row the engine does not run.
 */
export const DEPLOY_LIST_LOADING = "Loading deployments…";

/** The same wait, when the list read failed rather than being slow. */
export const DEPLOY_LIST_UNREAD =
  "The deployment list could not be read, so this cannot tell whether the engine is already " +
  "running. Reload the page to try again.";

/** The lead sentence of a failed press. Only a failure before the create may
 *  say nothing was created. */
export function deployErrorLead(err: unknown, created: boolean): string {
  // `addDeployment` throws the route's own sentence; a fetch that never landed
  // throws a TypeError whose message names nothing the operator can act on.
  const routeSentence = err instanceof Error && !(err instanceof TypeError) ? err.message : null;
  if (routeSentence != null) return routeSentence;
  return created ? DEPLOY_INTERRUPTED : DEPLOY_UNREACHABLE;
}

/** A failed press that created a row, with what became of that row. */
export function withRollback(lead: string, rolledBack: boolean): string {
  return `${lead} ${rolledBack ? DEPLOY_ROLLED_BACK : DEPLOY_ROLLBACK_FAILED}`;
}

/**
 * The books read failed, so the precedence question could not be asked. Said
 * rather than swallowed: silence here reads as *no book covers this*, which is
 * the one claim the notice exists to make correctly.
 */
export const BOOKS_UNREAD_NOTE =
  "The books could not be read, so this cannot say whether a book on this account also runs " +
  "this playbook.";

// ── What it deploys on ──────────────────────────────────────────────────

export type PlaybookDeployTarget =
  | { kind: "ready"; ticker: TickerSymbol }
  /** Deploy is disabled and `reason` is its title. */
  | { kind: "inert"; reason: string };

type DeployableModule = Pick<StrategyModule, "config" | "params" | "isTest">;

/**
 * The instrument, from `calibratedFor` and from nowhere else.
 *
 * The research-only refusal and the day-session refusal are asked here too,
 * each sentence passed through verbatim: either would 400 at the route, and a
 * refusal met only after pressing is worse than one that cannot be pressed. The instrument refusal is not asked
 * because it cannot fire — the ticker *is* the declaration.
 */
export function playbookDeployTarget(module: DeployableModule): PlaybookDeployTarget {
  const spec = module.config.calibratedFor;
  if (spec == null) return { kind: "inert", reason: NO_CALIBRATED_INSTRUMENT_REASON };
  const option = TICKER_OPTIONS.find((o) => o.symbol === `/${spec}`);
  if (!option) return { kind: "inert", reason: NO_CALIBRATED_INSTRUMENT_REASON };
  const undeployable = undeployableInstrumentRefusal(option.symbol);
  if (undeployable) return { kind: "inert", reason: undeployable };
  const daySession = daySessionRefusalFor(module.config, option.symbol);
  if (daySession) return { kind: "inert", reason: daySession };
  return { kind: "ready", ticker: option.symbol };
}

// ── The account rows ────────────────────────────────────────────────────

export interface DeployAccountRow {
  id: number;
  name: string;
  broker: AccountRow["broker"];
  /** The refusal's sentence verbatim, or null when the account may be
   *  deployed on — the live-account block's, else the account-state gate's.
   *  A refused row is **shown, disabled and stamped** — never dropped: a
   *  missing row is a third state the operator has to explain. */
  refusal: string | null;
  /** The refused row's stamp: `no auto-trade`, or the state gate's own
   *  (`Dead`, `Locked`, `DLL`, `OCO Off`, …). Null when not refused. */
  stamp: string | null;
  /** The stamp is the account-state gate's, so it renders in its own casing
   *  rather than upper-cased (`refusedStampClass`). */
  stampFromStateGate: boolean;
  /** Topstep's auto bracket is on: said beside Deploy, blocks nothing. */
  warning: string | null;
  /** A dead account's replacements, when a book or deployment uses it. */
  replacements: AccountGateWire["replacements"];
}

/** The live-account block's stamp, unchanged. */
export const NO_AUTO_TRADE_STAMP = "no auto-trade";

/**
 * Every account the picker offers, in the order it offers them.
 *
 * Two refusals, in the server screen's order: the live-account block, the
 * server's verdict on the account row (`autoTrade`), then the account-state
 * gate, **read off the server's answer** (`gates`, from `GET /api/books`) —
 * neither is derived here. `gates` null — not read yet, or the
 * read failed — refuses nothing on that ground: the press waits for the read
 * (`deployIntent`), and the route screens again regardless.
 */
export function buildDeployAccountRows(
  accounts: readonly AccountRow[],
  gates: readonly AccountGateWire[] | null = null,
): DeployAccountRow[] {
  const gateFor = new Map((gates ?? []).map((g) => [g.accountId, g]));
  return accounts.map((a) => {
    const verdict = a.autoTrade;
    const gate = gateFor.get(a.id) ?? null;
    if (!verdict.permitted) {
      return {
        id: a.id,
        name: a.name,
        broker: a.broker,
        refusal: verdict.reason,
        stamp: NO_AUTO_TRADE_STAMP,
        stampFromStateGate: false,
        warning: null,
        replacements: [],
      };
    }
    return {
      id: a.id,
      name: a.name,
      broker: a.broker,
      refusal: gate?.refusal?.reason ?? null,
      stamp: gate?.refusal?.stamp ?? null,
      stampFromStateGate: gate?.refusal != null,
      warning: gate?.warning ?? null,
      replacements: gate?.replacements ?? [],
    };
  });
}

/**
 * The picker's handler, which repeats the render's disable.
 *
 * A `disabled` radio is one devtools keystroke from live and a stale render can
 * hand a change to a row the current props refuse, so the choice is re-checked
 * against the same row the render drew. Null means *the selection does not
 * move*. Exported because a React-disabled control never dispatches, so the
 * guard is only testable here.
 */
export function pickDeployAccount(
  rows: readonly DeployAccountRow[],
  id: number,
): number | null {
  const row = rows.find((r) => r.id === id);
  if (!row || row.refusal != null) return null;
  return row.id;
}

// ── The precedence notice ──────────────────────────────────────────────

/** A row of `POST /api/deployments/conflict-check`'s `blocking` list. */
export interface BlockingDeployment {
  id: string;
  groupId: string;
  name: string | null;
  accountId: number;
}

export type DeployNotice =
  /** The route would refuse this create. Deploy is disabled with `text`. */
  | { kind: "refused"; text: string }
  /** The create goes through and changes something the operator cannot see
   *  from here. Stated beside Deploy; blocks nothing. */
  | { kind: "notice"; text: string };

export interface DeployNoticeInput {
  playbookName: string;
  strategyKey: string;
  ticker: TickerSymbol;
  accountId: number;
  /** `GET /api/books`, or null when that read did not answer. */
  books: readonly BookPayload[] | null;
  /** The server's conflict answer for this account, or null while it is out. */
  blocking: readonly BlockingDeployment[] | null;
}

/**
 * What the confirmation says about the book on the chosen account, if any.
 *
 * The rule is the reconciler's and it is narrower than *a hand-made deployment
 * beats a book*. The slot is `(account, ticker, playbook)` and only an
 * `Active` row holds it, so it cuts both ways depending on which arrived
 * first:
 *
 * - **The book's copy is already running** → the create route refuses this
 *   deployment (409, the session overlap), and the book keeps its row. Nothing
 *   stands down. Said before the press, with the move that clears it.
 * - **The book's copy is not running** (never materialised, stood down, or the
 *   book is off) and the playbook is armed on it → this deployment goes
 *   through and takes the slot. The reconciler then materialises nothing and
 *   resumes nothing for that playbook while this row is `Active`, and the grid
 *   marks the cell held. **Deleting this deployment does not bring the book's
 *   copy back by itself**: a stood-down row resumes only on a transition of
 *   the book or the playbook, so the notice names that move.
 * - Any other holder → the route refuses, naming it.
 *
 * A test fixture has no cell — the shelf excludes test modules by design — so
 * no notice is ever computed for one.
 */
export function deployNotice(input: DeployNoticeInput): DeployNotice | null {
  const { playbookName: name, ticker } = input;
  const book = input.books?.find((b) => b.accountId === input.accountId);
  const cell =
    book?.playbooks.find((p) => p.ticker === ticker && p.strategyKey === input.strategyKey) ??
    null;

  const holders = (input.blocking ?? []).filter((b) => b.accountId === input.accountId);
  if (holders.length > 0) {
    if (cell?.groupId != null && holders.some((h) => h.groupId === cell.groupId)) {
      return {
        kind: "refused",
        text:
          `This account's book already runs ${name} on ${ticker}, and a second copy over the ` +
          `same hours is refused. Turn ${name} off for this account on the Books screen first, ` +
          `or pick another account.`,
      };
    }
    const holder = holders[0].name ?? "Another deployment";
    const lead =
      `${holder} already runs ${name} on ${ticker} on this account over the same hours, and a ` +
      `second copy is refused.`;
    // Without the books there is no cell to tell a book's copy from a
    // hand-made one, and a book's copy refuses a delete — so only the move
    // that works for both.
    if (input.books == null) {
      return { kind: "refused", text: `${lead} ${BOOKS_UNREAD_NOTE} Pick another account.` };
    }
    return { kind: "refused", text: `${lead} Delete that deployment, or pick another account.` };
  }

  if (input.books == null) return { kind: "notice", text: BOOKS_UNREAD_NOTE };
  if (cell == null || !cell.armed) return null;
  return {
    kind: "notice",
    text:
      `This account's book has ${name} armed on ${ticker}. While this deployment is active, ` +
      `the book's copy runs nothing, and the Books screen marks it held. Deleting this ` +
      `deployment does not restart the book's copy by itself — turn ${name} off and back on ` +
      `for this account on the Books screen.`,
  };
}

// ── The same-contract warning ───────────────────────────────────────────

/** A row of `POST /api/deployments/conflict-check`'s `nonBlocking` list: a
 *  different playbook, `Active` on the same account and instrument, whose
 *  hours overlap this one's. */
export interface SameContractDeployment {
  id: string;
  name: string | null;
  strategyKey: string;
  accountId: number;
}

/**
 * What the confirmation says when another playbook already runs on this
 * account and instrument over the same hours — a playbook beside its own
 * capped variant is the case that prompted it.
 *
 * **A warning, never a refusal.** The route creates the row, and two playbooks
 * on one contract is a legitimate thing to want; what the operator cannot see
 * from here is that they share it. The engine admits one position per account
 * and contract: the second playbook's entry is dropped while the first holds
 * it, and stays dropped until that signal resets, so the race is real and
 * otherwise silent. The sentence says exactly that and nothing about which one
 * wins, because that is whichever signals first.
 *
 * The server's own answer, never a second derivation of it — the same route
 * the precedence notice reads, so the hours and the `Active` filter are the
 * ones the create route applies.
 */
export function sameContractWarning(input: {
  ticker: TickerSymbol;
  accountId: number;
  /** The conflict answer's `nonBlocking` rows, or null while it is out. */
  others: readonly SameContractDeployment[] | null;
}): string | null {
  const names = Array.from(
    new Set(
      (input.others ?? [])
        .filter((d) => d.accountId === input.accountId)
        .map((d) => d.name ?? d.strategyKey),
    ),
  );
  if (names.length === 0) return null;
  const subject = names.length === 1 ? `${names[0]} already runs` : `${names.join(", ")} already run`;
  return (
    `${subject} on ${input.ticker} on this account over the same hours. Only one position ` +
    `can be open on the contract: whichever signals first holds it until flat, and the ` +
    `other's entries in that time are dropped, not queued.`
  );
}

// ── The request ─────────────────────────────────────────────────────────

export interface DeployRequest {
  strategyKey: string;
  accountId: number;
  ticker: TickerSymbol;
  contractId: null;
  status: "Active";
  paramValues: ParamValues;
  name: null;
}

/**
 * The `POST /api/deployments` body: **the module's defaults and nothing
 * else** — `contractId` and `name` null, `Active` — so the route runs every
 * check it runs for any create.
 */
export function buildDeployRequest(
  strategyKey: string,
  module: DeployableModule,
  ticker: TickerSymbol,
  accountId: number,
): DeployRequest {
  return {
    strategyKey,
    accountId,
    ticker,
    contractId: null,
    status: "Active",
    paramValues: defaultParamValues(module.params),
    name: null,
  };
}

export type DeployIntent =
  | { kind: "write"; request: DeployRequest }
  /** `reason` is the button's title. */
  | { kind: "inert"; reason: string };

/**
 * Whether Deploy may be pressed, called in the render **and** in the handler
 * with the same operands.
 *
 * The refusals are checked in the order the operator can do something about
 * them: the playbook itself first (nothing on this screen fixes it), then the
 * deployment list the press reads, then the account, then the slot.
 */
export function deployIntent(input: {
  strategyKey: string;
  module: DeployableModule;
  target: PlaybookDeployTarget;
  rows: readonly DeployAccountRow[];
  accountId: number | null;
  notice: DeployNotice | null;
  /** True until the conflict answer for the chosen account has settled. */
  checking: boolean;
  /** `useDeploymentsLoadState()` — the press picks the engine action off
   *  that list, so it waits for one the server answered with. */
  loadState: DeploymentsLoadState;
  /** The open's status check and the books read after it have both settled,
   *  so the rows carry the account-state gate's answer. */
  accountsChecked: boolean;
}): DeployIntent {
  if (input.target.kind === "inert") return { kind: "inert", reason: input.target.reason };
  if (input.loadState === "failed") return { kind: "inert", reason: DEPLOY_LIST_UNREAD };
  if (input.loadState !== "ready") return { kind: "inert", reason: DEPLOY_LIST_LOADING };
  if (input.accountId == null) return { kind: "inert", reason: DEPLOY_PICK_ACCOUNT };
  const row = input.rows.find((r) => r.id === input.accountId);
  if (!row) return { kind: "inert", reason: DEPLOY_PICK_ACCOUNT };
  if (row.refusal != null) return { kind: "inert", reason: row.refusal };
  if (!input.accountsChecked) return { kind: "inert", reason: DEPLOY_CHECKING_ACCOUNTS };
  if (input.checking) return { kind: "inert", reason: "Checking this account…" };
  if (input.notice?.kind === "refused") return { kind: "inert", reason: input.notice.text };
  return {
    kind: "write",
    request: buildDeployRequest(input.strategyKey, input.module, input.target.ticker, row.id),
  };
}

// ── After the write ─────────────────────────────────────────────────────

/**
 * What the engine said about the row it was just handed, one sentence per
 * reason and never merged — an unclassified account clears on a reload, a
 * live one never will. The live-account sentence is the engine's verbatim.
 *
 * Only the row this press created is reported: `syncEngine` answers for the
 * whole deployment set, and a notice about some other row here would be a
 * claim about something the operator did not just do.
 */
export function heldBackSentences(
  result: {
    skippedNonPrac?: ReadonlyArray<{ id: string }>;
    skippedLiveAccounts?: ReadonlyArray<{ id: string; reason: string }>;
  },
  createdId: string,
): string[] {
  const out: string[] = [];
  if ((result.skippedNonPrac ?? []).some((s) => s.id === createdId)) {
    out.push("Practice-only is on, so the engine is holding it back. Turn Practice-only off to run it.");
  }
  for (const reason of new Set(
    (result.skippedLiveAccounts ?? []).filter((s) => s.id === createdId).map((s) => s.reason),
  )) {
    out.push(reason);
  }
  return out;
}
