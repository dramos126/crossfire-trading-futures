/**
 * The Dashboard board's decisions — everything the board answers that is not
 * markup.
 *
 * Fourth module on the `deployment-status.ts` / `trade-markers.ts` /
 * `board-model.ts` pattern, and the split from `board-model.ts` is by *input*
 * rather than by subject: that file is a pure function over the deployment
 * rows, this one is a pure function over the things a React tree holds — the
 * connection status, the visible-account set, the selector `useLivePnL`
 * hands back. Neither reaches the other's inputs, which is why they are two
 * files and not one.
 *
 * Four decisions live here because each is a sentence that is easy to write
 * wrong inside JSX and impossible to test there:
 *
 *   - **`boardSessionPnl`** — the wrapper that turns `useLivePnL`'s empty
 *     breakdown into the `null` `BoardInput` is typed for. Nothing in the
 *     type forces it; the whole em-dash guarantee is this one membership
 *     test.
 *   - **`presentBoard`** — empty is not error is not loading. `buildBoard`
 *     answers `[]` for all three.
 *   - **`cardToggleIntent` / `legToggleIntent`** — a ⏸/▶ over a row that is
 *     mid-close, and the one direction of it that retracts a close in flight.
 *   - **`cardEditIntent`** — which of the two sentences an inert ✎ carries,
 *     since `editHref` is null for a row whose config is *gone* and for a book
 *     card whose config is its rows'.
 *   - **`describeMissingMoney`** — which of the two reasons a row has no
 *     reading, so the em-dash carries a why.
 *   - **`describeOrphanReason`** and the two sentences beside it — what a
 *     detached row was stood down for, in words rather than in the stored
 *     code, and why pressing the way back off it is safe to describe.
 *   - **`boardRisk`** — what one entry on an account may lose, and which of
 *     the five endings a row is in. It picks `…` over `—` from a flag the
 *     hook sets on a *settled* read rather than inferring it from the absence
 *     of rows, and it carries the resolver's own refusal verbatim.
 *   - **`mergeUnmanagedClaims`** — one sweep's answers folded to rows, where
 *     a probe that could not answer must not delete a row it reported last
 *     time. It sits beside `preferUnmanagedClaim`, which is the dedupe it
 *     applies, rather than inside the effect that schedules it.
 *
 * Two rendering helpers sit here too, for the reason `statusToneClass` sits
 * in `deployment-status.ts`: `formatUsd` and `pnlToneClass` shipped as two
 * copies across `board.tsx` and `board-card.tsx` in one diff and had already
 * disagreed about what colour a zero is. One copy per surface is how eleven
 * of them got into this repo.
 */

import {
  readAccountRisk,
  RISK_NOT_SET_STAMP,
  type AccountRiskWireRow,
} from "@/components/account/account-risk-view";
import { BOOK_CARD_EDIT_REASON, BROKEN_ROW_EDIT_REASON } from "@/components/board/board-model";
import { maskUsdFigures } from "@/components/privacy/privacy-model";
import type { AccountStatusWire } from "@/app/api/accounts/status/route";
import type {
  BoardAccountStatus,
  BoardBook,
  BoardBookCell,
  BoardClaim,
  BoardDeployment,
  BoardLeg,
  BoardLegRisk,
  BoardRegime,
  BoardSessionPnl,
} from "@/components/board/board-model";
import type { DeploymentsLoadState } from "@/lib/hooks/use-strategies";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import type { ManualPositionPreview } from "@/lib/trading/activation-prompts";
import {
  BOOK_DERIVED_ROW_REFUSAL,
  groupEnableWouldRetractClose,
  isClosingStatus,
  isEngineManagedStatus,
  RESTORE_NEEDS_PLAYBOOK_ON,
  RESTORE_WOULD_RETRACT_A_CLOSE,
  RESUME_WOULD_RETRACT_A_CLOSE,
} from "@/lib/trading/domain";
import type { Deployment } from "@/lib/trading/domain";
import type { ForceFlatResult } from "@/lib/trading/engine/flatten/engine-force-flat";
import {
  ACCOUNT_RISK_PHASE_LABELS_COMPACT,
  usd,
} from "@/lib/trading/orders/account-phase-sizer";

// ── The em-dash guarantee ───────────────────────────────────────────────

/** The minimum of a deployment row this module needs to decide visibility. */
export interface PnlVisibilityRow {
  id: string;
  accountId: number;
}

/**
 * Wrap `useLivePnL(null, "session").deployment` into the
 * `(id) => PnLBreakdown | null` that `BoardInput.sessionPnl` declares.
 *
 * **This function is the entire em-dash guarantee and nothing in the type
 * system holds it up.** That selector is built over `trading.visibleAccounts`
 * and returns an *empty breakdown* — `$0.00`, `hasOpenPosition: false`,
 * structurally identical to a genuine flat zero — for any deployment outside
 * the set. Two kinds of row the board deliberately keeps are outside it by
 * construction: a **detached** leg, whose account is gone from the catalogue
 * by definition, and, with practice-only on, every non-`PRAC-` row. Passing
 * the selector straight through compiles, type-checks, renders, and quietly
 * tells the operator that a live account is flat.
 *
 * So the membership test is explicit and stated forwards: a reading exists
 * only for a row this list names *and* whose account is visible. An id the
 * board asks about that is in neither answers `null` rather than zero, which
 * is also the honest answer for a row deleted out from under a render.
 *
 * It takes the account set rather than deriving one, because
 * `visibleAccounts` is the same list `useLivePnL` filters by — deriving a
 * second is how the two get to disagree about which mode is on.
 *
 * **The return type is branded, and this assertion is the only one in
 * `src/`.** Without it the guarantee was one untyped wiring line: the raw
 * selector is `(id) => PnLBreakdown`, which is assignable to
 * `(id) => PnLBreakdown | null`, so a future tidy of `board.tsx` down to
 * `sessionPnl: livePnl.deployment` compiled, type-checked, passed every test
 * and silently reported every detached and practice-filtered account as
 * flat. See {@link BoardSessionPnl}.
 */
export function boardSessionPnl(args: {
  deployments: readonly PnlVisibilityRow[];
  visibleAccountIds: ReadonlySet<number>;
  deployment: (id: string) => PnLBreakdown;
}): BoardSessionPnl {
  const readable = new Set<string>();
  for (const d of args.deployments) {
    if (args.visibleAccountIds.has(d.accountId)) readable.add(d.id);
  }
  const select = (deploymentId: string): PnLBreakdown | null =>
    readable.has(deploymentId) ? args.deployment(deploymentId) : null;
  return select as BoardSessionPnl;
}

// ── The regime chip ─────────────────────────────────────────────────────

/** One row of `GET /api/regime`, as the board needs it. */
export interface RegimeReading {
  ticker: string;
  label: string;
  features: {
    vol5: number;
    vol5Pct: number;
    rthRange: number;
    rangeRatio: number;
  } | null;
}

/**
 * `BoardInput.regime` from a session's readings.
 *
 * Two things it decides, and both are the kind that renders a lie inside JSX.
 * **The ticker match is on the contract-table spelling**, so a `/MNQ` card
 * finds an `MNQ` row rather than silently showing no chip on every card in
 * the install. And **the tooltip says what the label does not mean** — no
 * playbook is armed or stood down by it in this phase, so a chip with only a
 * cell name on it is read as an arming state, which is the one claim the
 * surface cannot make yet.
 *
 * It is also where the fetched body is narrowed: `features` arrives from a
 * cast JSON payload, and the tooltip calls `.toFixed()` on three of its
 * numbers. A malformed one is treated as no features — the sentence that says
 * the reading is unavailable — rather than throwing inside render.
 */
export function boardRegime(
  readings: readonly RegimeReading[],
): (ticker: string) => BoardRegime | null {
  const byTicker = new Map<string, RegimeReading>();
  for (const reading of readings) {
    byTicker.set(
      reading.ticker,
      measurable(reading.features) ? reading : { ...reading, features: null },
    );
  }

  return (ticker: string): BoardRegime | null => {
    const reading = byTicker.get(ticker.replace(/^\//, ""));
    if (reading == null) return null;
    return { label: reading.label, detail: describeRegime(reading) };
  };
}

/** The three numbers the tooltip renders, all present and finite. */
function measurable(features: RegimeReading["features"]): boolean {
  return (
    features != null &&
    Number.isFinite(features.vol5) &&
    Number.isFinite(features.vol5Pct) &&
    Number.isFinite(features.rangeRatio)
  );
}

/**
 * The chip's tooltip. Features in a trader's words — a five-day average range
 * and where it sits in the year, and yesterday's range against its own recent
 * median — never the feature names.
 *
 * `unknown` gets the recoverable sentence rather than the measurement, for
 * the same reason an unclassified account does: the operator's question is
 * whether anything is wrong, and the answer is that the label is not
 * available for this session and nothing depends on it.
 *
 * Module-private: `boardRegime` is the only door, and it is what normalises
 * the ticker. A second caller reaching this directly would render a chip for
 * a reading it matched some other way.
 */
function describeRegime(reading: RegimeReading): string {
  if (reading.features == null) {
    return (
      "No regime reading for this session — there is not enough completed history " +
      "to measure it. Nothing changes; no strategy is armed or stood down by the regime."
    );
  }
  return (
    `5-day average range ${reading.features.vol5.toFixed(0)} ticks, ` +
    `${reading.features.vol5Pct.toFixed(0)}th percentile of the last year.\n\n` +
    `Yesterday's range ${reading.features.rangeRatio.toFixed(2)}× its 20-day median.\n\n` +
    "Observed only — no strategy is armed or stood down by the regime yet."
  );
}

// ── What one entry may lose ─────────────────────────────────────────────

/**
 * The sentence every arm that prints a number carries, and the reason this
 * field is keyed by account.
 *
 * A budget on a row invites exactly one misreading — *this row has that much
 * at risk* — and two legs on one account print it twice while sharing one
 * budget. The sentence says both halves plainly: it is per entry, and it is
 * the account's rather than the row's.
 */
export const RISK_IS_THE_ACCOUNTS =
  "Every deployment on this account is sized to this same budget. It is what one entry may lose at its stop, not what this row has at risk.";

/** Where the operator changes it. The section's own label, never a position
 *  and never a path — [copy.md](../../docs/modules/ui/copy.md). */
const RISK_LIVES_IN_SETTINGS = "Set it in Settings, under Risk.";

export const RISK_NOT_SET_DETAIL =
  `No risk per trade is set for this account, so the engine takes no entry on it — ` +
  `it sizes every entry to the budget and refuses rather than picking a number. ${RISK_LIVES_IN_SETTINGS}`;

export const RISK_UNREADABLE_DETACHED =
  "No risk reading — this account is no longer in the broker's account list, so nothing can say what it may risk. Reassign the account to recover the row.";

export const RISK_UNREADABLE_READ_FAILED =
  "No risk reading — the account risk settings could not be read. The engine still sizes from the stored ones; reload to see them here.";

/** The word on a row the rule model cannot price. It is not `Error` or
 *  `Blocked` — like the `no auto-trade` stamp it states what the platform
 *  will do, and the sentence beside it is the resolver's own. */
const RISK_NO_ENTRIES_STAMP = "no entries";

/**
 * `BoardInput.risk` from the catalogue's risk rows and a clock.
 *
 * **Four things it decides, and each of them renders and lies if written in
 * JSX.**
 *
 * *(1) Which blank.* `rows == null` is two different facts — the first read
 * is still out, or it answered and failed — and they get `…` and `—`
 * respectively. The caller passes `failed` rather than letting this infer it
 * from the absence of rows, because a surface that can never stop loading is
 * the documented mirror-image defect: the em-dash arm has to be reachable by
 * a state something actually writes.
 *
 * *(2) An account the rows do not name* is a detached leg, whose catalogue
 * row is gone by definition. It gets the em-dash and the same recoverable
 * sentence its money already carries, not a zero and not a blank.
 *
 * *(3) A budget nobody set is not a budget of zero.* The account takes no
 * entry at all, which is a state to fix rather than a number to read, so it
 * takes the `not set` stamp in the `--warning` tone the Risk block's own pill
 * uses — one wording, from `account-risk-view.ts`.
 *
 * *(4) A resolver throw is an ending, not an error*, and its sentence is
 * carried verbatim. Those are the engine's constants and the operator meets
 * the same words here, in `/logs` and on the Risk block's own line.
 *
 * **The arithmetic is not here.** `readAccountRisk` calls the engine's own
 * `resolveSessionBudget`, so this function chooses words and a tone and
 * nothing else — a second arithmetic on the board would be the `formatUsd`
 * census failure with money at stake.
 */
export function boardRisk(args: {
  rows: readonly AccountRiskWireRow[] | null;
  /** Whether the read has settled without an answer. `rows == null && !failed`
   *  is the only state that renders `…`. */
  failed: boolean;
  now: Date;
}): (accountId: number) => BoardLegRisk {
  if (args.rows == null) {
    const answer: BoardLegRisk = args.failed
      ? { kind: "unreadable", detail: RISK_UNREADABLE_READ_FAILED }
      : { kind: "pending" };
    return () => answer;
  }
  const byAccount = new Map(args.rows.map((r) => [r.accountId, r]));
  return (accountId: number): BoardLegRisk => {
    const row = byAccount.get(accountId);
    if (row == null) return { kind: "unreadable", detail: RISK_UNREADABLE_DETACHED };
    const reading = readAccountRisk(row, args.now);
    switch (reading.kind) {
      case "unset":
        return {
          kind: "blocked",
          note: RISK_NOT_SET_STAMP,
          tone: "warning",
          detail: RISK_NOT_SET_DETAIL,
        };
      case "refused":
        return {
          kind: "blocked",
          note: RISK_NO_ENTRIES_STAMP,
          tone: "danger",
          detail: `${reading.reason}\n\n${RISK_IS_THE_ACCOUNTS}`,
        };
      case "flat":
        return {
          kind: "budget",
          amount: usd(reading.budgetUsd),
          // No phase is set, so there is no phase to name — and `Off` beside a
          // live budget reads as the budget being off.
          note: null,
          tone: "muted",
          detail:
            `${usd(reading.budgetUsd)} is the risk per trade set for this account. No account ` +
            `phase is set, so it does not move with the account's balance.\n\n` +
            `${RISK_IS_THE_ACCOUNTS}\n\n${RISK_LIVES_IN_SETTINGS}`,
        };
      case "lowest":
        return {
          kind: "budget",
          amount: usd(reading.budgetUsd),
          note: `${ACCOUNT_RISK_PHASE_LABELS_COMPACT[reading.phase]} · lowest`,
          tone: "warning",
          detail:
            `${usd(reading.budgetUsd)} is the lowest budget this account's phase allows, and it ` +
            `is running on it because there is ${
              reading.everSampled
                ? "no close on record for this session yet"
                : "no close on record yet"
            }.\n\n${RISK_IS_THE_ACCOUNTS}\n\n${RISK_LIVES_IN_SETTINGS}`,
        };
      case "sized": {
        // The arithmetic clause is appended only when there is arithmetic to
        // state. The phase and the budget are facts of the row either way;
        // *headroom over a floor* is a specific claim and does not get made
        // up to keep a sentence whole.
        const facts =
          reading.headroomUsd != null && reading.floorUsd != null
            ? `: ${headroomClause(reading.headroomUsd, reading.floorUsd)}`
            : "";
        return {
          kind: "budget",
          amount: usd(reading.budgetUsd),
          note: ACCOUNT_RISK_PHASE_LABELS_COMPACT[reading.phase],
          tone: "muted",
          detail:
            `${usd(reading.budgetUsd)} today, sized from this account's phase and its last ` +
            `recorded close${facts}.\n\n${RISK_IS_THE_ACCOUNTS}\n\n${RISK_LIVES_IN_SETTINGS}`,
        };
      }
    }
  };
}

function headroomClause(headroomUsd: number, floorUsd: number): string {
  return `headroom ${usd(headroomUsd)} over a ${usd(floorUsd)} floor`;
}

const HEADROOM_CLAUSE = /headroom \S+ over a \S+ floor/;

/**
 * A risk cell with its balance hidden. Headroom over a floor is the balance by
 * addition, so that clause is masked; the budget itself is a risk figure and
 * stays. A `blocked` cell's detail is the resolver's own refusal, which states
 * the close against the floor, so every figure in it is masked.
 */
export function maskRiskBalance<R extends BoardLegRisk>(risk: R, hideBalances: boolean): R {
  if (!hideBalances || !("detail" in risk)) return risk;
  if (risk.kind === "blocked") return { ...risk, detail: maskUsdFigures(risk.detail, true) };
  return { ...risk, detail: risk.detail.replace(HEADROOM_CLAUSE, (c) => maskUsdFigures(c, true)) };
}

// ── The account's balance and its state stamp ───────────────────────────

/** What every stated balance's tooltip says about where it came from. */
export const BALANCE_SOURCE_NOTE =
  "Topstep's account balance, read by the account check at 17:55 ET each weekday, about ten " +
  "seconds after a position closes, hourly while a check is failing, and when Settings or " +
  "Books opens. It does not move with an open position between checks.";

export const BALANCE_NEVER_READ =
  "No balance on record — the account check has not read one from Topstep for this account yet. " +
  "It reads one at 17:55 ET each weekday, after a position closes, and when Settings or Books opens.";

export const BALANCE_NOT_CARRIED =
  "No balance — Tradovate's account list does not carry one, so the account check has none to show.";

/** A row whose stored broker is neither one: promise no read that may never come. */
export const BALANCE_NOT_READ = "No balance — none has been read for this account.";

export const BALANCE_NOT_CATALOGUED =
  "No balance — this account is not in the platform's account list, so nothing is stored for it.";

export const BALANCE_READ_FAILED =
  "No balance — the stored account status could not be read. Reload the page to try again.";

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const ET_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
});
const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** `17:55 ET` for an instant on `now`'s New York day, `Oct 20, 17:55 ET`
 *  otherwise — so a read that stopped answering shows its age. */
export function etAsOf(iso: string, now: Date): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = `${ET_TIME.format(at)} ET`;
  return ET_DATE.format(at) === ET_DATE.format(now) ? time : `${ET_DAY.format(at)}, ${time}`;
}

const isNumOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v));
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";

/** `GET /api/accounts/status`' body, narrowed at the boundary: null when it is
 *  not a list of rows, and any row of the wrong shape dropped — an unreadable
 *  row reads as not catalogued, never as a zero. */
export function toAccountStatusRows(body: unknown): AccountStatusWire[] | null {
  if (typeof body !== "object" || body === null) return null;
  const accounts = (body as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return null;
  return accounts.filter((a): a is AccountStatusWire => {
    if (typeof a !== "object" || a === null) return false;
    const r = a as Record<string, unknown>;
    const refusal = r.refusal as Record<string, unknown> | null | undefined;
    return (
      typeof r.accountId === "number" &&
      (r.broker === "topstep" || r.broker === "tradovate" || r.broker === "unknown") &&
      isNumOrNull(r.balanceUsd) &&
      isStrOrNull(r.balanceAt) &&
      isStrOrNull(r.checkedAt) &&
      (refusal === null ||
        (typeof refusal === "object" &&
          refusal !== undefined &&
          typeof refusal.stamp === "string" &&
          typeof refusal.reason === "string"))
    );
  });
}

/**
 * What a book card's header says about its account: the balance the account
 * check last stored, and the account-state gate's stamp when it refuses.
 * `rows == null && !failed` is the only state that renders `…`, for
 * `boardRisk`'s reason.
 *
 * **The stamp is the route's `readAccountGates` verdict carried through**, its
 * text the gate's `*_STAMP` and its reason verbatim; this function adds only
 * when the check that decided it ran.
 */
export function boardAccountStatus(args: {
  rows: readonly AccountStatusWire[] | null;
  failed: boolean;
  now: Date;
}): (accountId: number) => BoardAccountStatus {
  if (args.rows == null) {
    const answer: BoardAccountStatus = {
      balance: args.failed ? { kind: "unknown", detail: BALANCE_READ_FAILED } : { kind: "pending" },
      stamp: null,
    };
    return () => answer;
  }
  const byAccount = new Map(args.rows.map((r) => [r.accountId, r]));
  return (accountId) => {
    const row = byAccount.get(accountId);
    if (!row) return { balance: { kind: "unknown", detail: BALANCE_NOT_CATALOGUED }, stamp: null };
    const checked = row.checkedAt == null ? null : etAsOf(row.checkedAt, args.now);
    const stamp =
      row.refusal == null
        ? null
        : {
            text: row.refusal.stamp,
            detail:
              checked == null
                ? row.refusal.reason
                : `${row.refusal.reason}\n\nAs of the account check at ${checked}.`,
          };
    const asOf = row.balanceAt == null ? null : etAsOf(row.balanceAt, args.now);
    if (row.balanceUsd == null || !Number.isFinite(row.balanceUsd) || asOf == null) {
      const detail =
        row.broker === "topstep"
          ? BALANCE_NEVER_READ
          : row.broker === "tradovate"
            ? BALANCE_NOT_CARRIED
            : BALANCE_NOT_READ;
      return { balance: { kind: "unknown", detail }, stamp };
    }
    return {
      balance: {
        kind: "amount",
        amount: usd(row.balanceUsd),
        detail: `Balance as of ${asOf}\n\n${BALANCE_SOURCE_NOTE}`,
      },
      stamp,
    };
  };
}

// ── Money that is present, and what colour it is ────────────────────────

/** `+$120.00` / `-$40.00` / `$0.00`. Sign-first so a column of them scans. */
export function formatUsd(v: number): string {
  const sign = v < 0 ? "-" : v > 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

/**
 * Sign colour for a P&L figure. **One copy for the whole board**, which is
 * the fix rather than a tidy: the strip's and the card's shipped in one diff
 * and already disagreed on zero.
 *
 * **Zero is `--foreground`, not `--muted`.** The function answers the *sign*,
 * and no sign means no colour claim — the tier the figure sits in decides its
 * weight. Muting it would also dim data on a row, which the board's own Hard
 * rule forbids: a `$0.00` a leg genuinely earned is a reading, and it is not
 * the em-dash that says there is none.
 */
export function pnlToneClass(v: number): string {
  if (v > 0) return "text-[var(--success)]";
  if (v < 0) return "text-[var(--danger)]";
  return "text-[var(--foreground)]";
}

// ── Money that is missing, and why ──────────────────────────────────────

/**
 * Why a row has no P&L reading. Both are tooltips on an em-dash, and the
 * em-dash covers `sessionPnl` **and** `openPositionCount` together — they go
 * blind together because they come from one selector, and a card showing
 * "0 open" beside a dashed total answers one of the two questions with a
 * number nobody can stand behind.
 */
export const DETACHED_MONEY_UNAVAILABLE =
  "No P&L reading — this account is no longer in the broker's account list, so nothing can price it. Reassign the account to recover the row.";

export const PRACTICE_FILTER_MONEY_UNAVAILABLE =
  "No P&L reading — practice-only is on, so trades and positions on this account are not being counted. Turn it off to see this row's money.";

/**
 * Which of the two applies. Detached wins when both do: an account that is
 * gone is gone in either mode, and telling the operator to flip a toggle
 * that will not bring it back is the worse of two answers.
 *
 * `null` when the row has a reading — the caller renders the number.
 */
export function describeMissingMoney(card: {
  sessionPnl: PnLBreakdown | null;
  legs: readonly { detached: boolean }[];
}): string | null {
  if (card.sessionPnl != null) return null;
  return card.legs.some((l) => l.detached)
    ? DETACHED_MONEY_UNAVAILABLE
    : PRACTICE_FILTER_MONEY_UNAVAILABLE;
}

/** The leg-level form of the same rule. */
export function describeMissingLegMoney(leg: {
  sessionPnl: PnLBreakdown | null;
  detached: boolean;
}): string | null {
  if (leg.sessionPnl != null) return null;
  return leg.detached ? DETACHED_MONEY_UNAVAILABLE : PRACTICE_FILTER_MONEY_UNAVAILABLE;
}

/**
 * A row the board can read whose open position nothing prices: the trade row
 * says it is open, but the broker's position list has not matched it or no
 * quote has arrived. Its `U:` and every total over it are em-dashes (A68).
 */
export const UNREALIZED_UNPRICED =
  "No unrealized P&L reading — this open position has no live price right now. The broker's position list has not matched it yet, or no quote has arrived.";

export const TOTAL_UNPRICED =
  "No total — an open position here has no live price right now, so its unrealized P&L cannot be added in.";

/** Why a leg's `U:` is an em-dash, or `null` when it has a figure. */
export function describeMissingUnrealized(leg: {
  sessionPnl: PnLBreakdown | null;
  detached: boolean;
}): string | null {
  const missing = describeMissingLegMoney(leg);
  if (missing != null) return missing;
  return leg.sessionPnl?.unrealized == null ? UNREALIZED_UNPRICED : null;
}

// ── A detached row, and the way back off it ─────────────────────────────

/**
 * The recovery control's own label.
 *
 * Exported because two sentences name it — the note under the reason and the
 * refusal on the row's `▶` — and
 * [copy.md](../../docs/modules/ui/copy.md) requires a redirecting sentence to
 * carry the target's label **verbatim** rather than a synonym. A second
 * spelling of it is a reader matching nothing.
 *
 * It says both halves of what the press does, because the endpoint does both:
 * `clearOrphanedAndReEnable` clears the markers **and** writes
 * `status = 'Active', enabled = 1`. A label reading *Restore* alone would hide
 * the arming behind the recovery, on a funded-track account.
 */
export const DETACHED_RECOVER_LABEL = "Restore and arm";

/**
 * What the platform actually recorded, per reason code, in words.
 *
 * The codes are **persisted** into the deployment row and frozen
 * ([engine.ts](../lib/trading/engine/engine.ts), `ORPHAN_PAUSE_REASONS`, plus
 * the three detection sites that pass their own literal), so this is a
 * rendering of them and never a second vocabulary. Each sentence says **what
 * was observed and when**, never why — *"the broker's account list did not name
 * this account"* is a reading; *"the account was closed"* is a cause nobody
 * checked, and it is the exact wrong cause here ([bugs.md](../../docs/bugs.md)
 * A74: every one of these rows was live at the broker the whole time).
 *
 * The three list-check codes differ only in *which* check ran, and that is
 * kept rather than collapsed: a boot inside the nightly maintenance window and
 * a check on a running engine are different events, and telling them apart is
 * what the operator opens this strip to do. **None of them dates the event.**
 * The boot sentence read *"when it last started"*, which stops being true at
 * the next restart — the marker outlives it, and `orphanedAt` (the one field
 * that could date it) is not projected onto `BoardLeg`. Naming the check
 * rather than the occasion is the honest form; do not put "last" back without
 * the timestamp behind it.
 */
const ORPHAN_REASON_SENTENCES: Record<string, string> = {
  account_unavailable_at_boot:
    "The engine stood this deployment down on a start-up account check: the broker's account list did not name this account.",
  periodic_account_check:
    "The engine stood this deployment down on a routine account check: the broker's account list did not name this account.",
  page_render_account_check:
    "The engine stood this deployment down on an account check from the board: the broker's account list did not name this account.",
  place_order_account_not_found:
    "The engine stood this deployment down when the broker answered an order on this account with account-not-found.",
  tradovate_account_not_active:
    "The engine stood this deployment down when Tradovate reported this account as not active.",
  tradovate_captcha_lockout:
    "The engine stood this deployment down when Tradovate answered the login with a captcha challenge.",
  tradovate_unauthorized:
    "The engine stood this deployment down when Tradovate rejected the login for this account.",
};

/**
 * The reason a row is detached, in a sentence.
 *
 * **A code this table does not know is quoted, not guessed.** The stored
 * strings are frozen and a new detection site can add one without passing
 * here; inventing prose for it would state something nobody checked, and the
 * raw code is at least true — the same call the chart's `EXIT` fallback makes.
 */
export function describeOrphanReason(reason: string | null): string {
  if (reason == null) return "The engine stood this deployment down and recorded no reason.";
  return (
    ORPHAN_REASON_SENTENCES[reason] ??
    `The engine stood this deployment down and recorded “${reason}”.`
  );
}

/**
 * The sentence beside every reason, and the one that closes
 * [bugs.md](../../docs/bugs.md) A74's copy half.
 *
 * **It must not tell the operator their account is gone**, because usually it
 * is not: a fan-out the platform could not complete and an account that really
 * went produce the identical marker, and two trading days on a live combine
 * were lost to a red chip that read as the second. It must equally not send
 * them to the prop firm over a rule this app made
 * ([copy.md](../../docs/modules/ui/copy.md)) — so it names no broker, no
 * support channel and no page to go and check.
 *
 * It ends in the operator's move and says what the platform does if the guess
 * is wrong, which is what makes pressing it safe to describe: the detection
 * sites are still running, so a row that really has lost its account is stood
 * down again rather than left arming into nothing.
 */
export const DETACHED_RECOVER_NOTE =
  "A check the platform could not finish and an account that really went look the same from here, so a detached row is often still fine. " +
  `${DETACHED_RECOVER_LABEL} puts this deployment back to Active and re-arms it for entries; if the account is genuinely unavailable the platform stands it down again.`;

/**
 * Why `Restore and arm` is refused on this row, or `null` when it is live.
 *
 * **A detached row can be mid-close**, because `markOrphaned` preserves
 * `Pausing` / `Destroying` — the close is owed whether or not the account
 * answers — and `place_order_account_not_found` is raised by the very
 * `placeOrder` the closing guard issues. The route 409s on that row with this
 * same sentence ([domain.ts](../lib/trading/domain.ts)), so the control is
 * disabled with it rather than left live in front of a refusal: the inert-`✎`
 * rule again, and `RESTORE_WOULD_RETRACT_A_CLOSE` is one constant for the same
 * reason `BOOK_DERIVED_ROW_REFUSAL` is.
 *
 * It is the leg's `status` through the shipped `isClosingStatus`, never
 * `chip.kind` — the chip's ladder puts `detached` above `pausing`, so on this
 * row the closing state is never on the chip to be read. Same signal, same
 * predicate and same reasoning as `legToggleIntent`'s closing arm.
 *
 * **A book's row under a switched-off parent is the second refusal**, in the
 * route's order: `clearOrphanedAndReEnable` leaves the parent off, so the
 * route 409s with `RESTORE_NEEDS_PLAYBOOK_ON`, which names the book's
 * off-and-on as the first move (bugs.md A85). `bookId` is the **card's**, for
 * the reason `legToggleIntent` takes it; the parent's switch is the leg's own,
 * because a book card's rows each have a parent of their own.
 */
export function detachedRestoreRefusal(
  leg: Pick<BoardLeg, "status" | "parentEnabled">,
  bookId: string | null,
): string | null {
  if (isClosingStatus(leg.status)) return RESTORE_WOULD_RETRACT_A_CLOSE;
  if (bookId != null && !leg.parentEnabled) return RESTORE_NEEDS_PLAYBOOK_ON;
  return null;
}

// ── The toggle, and the direction of it that is not safe ────────────────

/**
 * What a ⏸/▶ press means, decided rather than inferred at the button.
 *
 * `inert` is a rendered, disabled control with a reason in its tooltip — not
 * a hidden one. A control that vanishes while a row is closing reads as a
 * bug; one that is visibly refused reads as the rule it is.
 */
export type ToggleIntent =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "inert"; reason: string };

/**
 * Why a detached row's `▶` is inert, and which control is the live one.
 *
 * A plain resume writes `status = 'Active'` and nothing else:
 * `PATCH /api/deployments/[id]` clears the orphan markers **only** when
 * `accountId` actually changes, so the row comes back reading `Detached` with
 * its markers intact — a control that looks like it worked and left the state
 * the operator was trying to leave. Refusing before the press rather than
 * after it is the inert-`✎` rule on a third control type
 * ([design-language.md](../../docs/modules/ui/design-language.md)).
 *
 * **Only the resume direction.** Pausing a detached row is the operator's own
 * stand-down and stays live, the same one-directional shape
 * `cardToggleIntent`'s closing arm has.
 */
export const DETACHED_RESUME_REFUSAL =
  `Resuming does not clear a detached row — the markers stay and it keeps reading Detached. Use ${DETACHED_RECOVER_LABEL} on this row instead.`;

/**
 * The card's toggle, over the surface `target` names.
 *
 * **`switchOn` alone is not enough, and the gap is one-directional.** It is
 * `false` on `Pausing` and `Destroying` — correctly, that is the switch
 * position — so a button rendered from it alone shows ▶ over a row that is
 * mid-close, and pressing it submits `{status: "Active"}` or
 * `{enabled: true}`. On a `deployment` target that is a resume the API takes;
 * on a `group` target it is a live transition that runs
 * `enableGroupAndRestore`. Either way it retracts a close the operator asked
 * for, and on a `deployment` target's destroy it retracts the destroy.
 *
 * The other direction is fine and stays live: with `switchOn` true the button
 * is ⏸, and pausing a card whose legs are already closing is an escalation
 * rather than a contradiction — that is exactly the state a per-leg pause
 * inside an enabled group produces, and refusing it would strand the group.
 *
 * **The signal is `legs[].status` through the routes' own predicates, not
 * `chip.kind`.** Two reasons and the first is a correctness one: the chip is
 * a *ladder* with a documented precedence, and `detached` sits above
 * `pausing` — so a detached leg mid-destroy reports `kind: "detached"` and
 * the closing state is simply not on the chip to be read. The second is that
 * each predicate is the one the route behind the press refuses on, so the
 * render and the write agree by construction rather than by coincidence: on a
 * `group` target, `groupEnableWouldRetractClose` — `Pausing` alone, because
 * `enableGroupAndRestore` skips a `Destroying` leg and refusing over one would
 * strand its siblings; on a `deployment` target, `isClosingStatus`, because
 * that ▶ writes `Active` onto the leg itself and over `Destroying` that
 * retracts the delete.
 *
 * **A derived row outranks both arms**, because `PATCH /api/groups/[id]`'s
 * enable arm 409s on one and the switch is not the operator's to throw at all
 * — the reconciler writes a derived row's state and nothing else does. It is
 * decided here rather than composed at the card for the reason every other
 * answer in this file is: two surfaces read this toggle's direction, and a
 * refusal applied at one of them is a refusal the other can forget. The
 * closing arm sits below it because a close in flight is transient and this is
 * not.
 */
export function cardToggleIntent(
  card: Pick<BoardDeployment, "switchOn" | "legs" | "bookId" | "target">,
): ToggleIntent {
  if (card.bookId != null) return { kind: "inert", reason: BOOK_DERIVED_ROW_REFUSAL };
  if (card.switchOn) return { kind: "pause" };
  const resumeRetractsClose =
    card.target.kind === "group" ? groupEnableWouldRetractClose : isClosingStatus;
  if (card.legs.some((l) => resumeRetractsClose(l.status))) {
    return { kind: "inert", reason: RESUME_WOULD_RETRACT_A_CLOSE };
  }
  // **Every leg, not any.** A resume that would leave the whole card detached
  // is the leg glyph's defect at card scale; a card with one detached leg
  // among three has two the resume genuinely starts, and refusing it would
  // strand them behind a row they have nothing to do with.
  if (card.legs.length > 0 && card.legs.every((l) => l.detached)) {
    return { kind: "inert", reason: DETACHED_RESUME_REFUSAL };
  }
  return { kind: "resume" };
}

/**
 * A leg's own toggle, which is `PATCH /api/deployments/[id] {status}` and is
 * directed by `leg.status === "Active"` rather than by the card's `switchOn`
 * — a leg inside a disabled group still has a switch of its own to flip.
 *
 * Stricter than the card's in one direction, deliberately: a closing leg is
 * inert **either way round**, because `toggleDeployment` refuses a closing
 * row outright. A live ⏸ over one would be a control that does nothing at
 * all. The glyph on a closing leg is ▶ — its status is not `Active` — so the
 * press it stands for is a resume, and its title is the sentence the route
 * refuses that resume with, `RESUME_WOULD_RETRACT_A_CLOSE`: one refused press,
 * one sentence, on the leg and on the card.
 *
 * **`bookId` is the card's and is passed in, because the pointer is the
 * parent's.** `PATCH /api/deployments/[id]` 409s on a `status` write to any leg
 * of a derived row, so this glyph is refused for the card's reason rather than
 * for one of its own — and it is the same constant and the same precedence the
 * card's toggle uses, so the two controls on one card cannot answer
 * differently. It is a parameter rather than a field on `BoardLeg` to keep one
 * authoritative copy of the pointer per card; a leg that carried its own would
 * be a second place for it to be wrong.
 */
export function legToggleIntent(
  leg: Pick<BoardLeg, "status" | "detached">,
  bookId: string | null,
): ToggleIntent {
  if (bookId != null) return { kind: "inert", reason: BOOK_DERIVED_ROW_REFUSAL };
  if (isClosingStatus(leg.status)) return { kind: "inert", reason: RESUME_WOULD_RETRACT_A_CLOSE };
  // The pause direction first, so a detached row that is somehow `Active` can
  // still be switched off — the refusal below is about the resume alone. The
  // closing arm stays above both: a detached row mid-close still owes its
  // close, which is why `markOrphaned` preserves a closing status.
  if (leg.status === "Active") return { kind: "pause" };
  if (leg.detached) return { kind: "inert", reason: DETACHED_RESUME_REFUSAL };
  return { kind: "resume" };
}

// ── The ✎, and the two different reasons it has nowhere to point ─────────

/** What the `✎` does, decided rather than composed at the control. */
export type EditIntent =
  | { kind: "link"; href: string }
  | { kind: "inert"; reason: string };

/**
 * The `✎`'s two arms, and **which sentence an inert one carries**.
 *
 * `editHref` is null for two different facts and they are not the same
 * message. A **broken row** — a leg whose parent is gone — has nothing to
 * edit because the configuration went with the row, and its own sentence says
 * so while naming the two controls that still work. A **book card** has plenty
 * to edit and no single subject: it is an account, and each
 * of its rows is a playbook with its own page. Rendering the broken-row
 * sentence there would tell the operator their settings are gone.
 *
 * It is decided here for the reason the toggle intents are: the card should
 * not pick a refusal in JSX, and a second surface rendering this control gets
 * the same answer by construction.
 */
export function cardEditIntent(
  card: Pick<BoardDeployment, "editHref" | "bookId">,
): EditIntent {
  if (card.editHref != null) return { kind: "link", href: card.editHref };
  return {
    kind: "inert",
    reason: card.bookId != null ? BOOK_CARD_EDIT_REASON : BROKEN_ROW_EDIT_REASON,
  };
}

// ── The unmanaged strip's cadence and its dedupe ────────────────────────

/** The guard's own sweep cadence. Restated rather than imported —
 *  `engine-manual-position.ts` drags the server graph into the browser
 *  bundle, and this is a number the strip has to keep in step with rather
 *  than derive from. */
export const UNMANAGED_PROBE_MS = 15_000;

/** Four minutes. Long enough that a rate-limited tab stops competing with
 *  the engine for the broker session it shares; short enough that a strip
 *  left open recovers without a reload. */
export const UNMANAGED_PROBE_MAX_BACKOFF_MS = 240_000;

/**
 * How long to wait after `n` consecutive sweeps in which **every** probe
 * failed.
 *
 * The strip is one live broker round-trip per armed leg, every 15s, per tab,
 * forever. Three grouped deployments across four accounts is twelve armed
 * legs — 48 position searches a minute from one tab, 96 from two — and
 * `.catch(() => null)` swallows a 429 so the interval re-fires at full width
 * against a broker that is already refusing. The engine shares that session,
 * so the strip competes for rate limit with the very sweep it previews.
 *
 * `0` while sweeps are landing: the ordinary interval is the cadence, and
 * backoff is a response to failure rather than a second schedule.
 */
export function unmanagedBackoffMs(consecutiveFailedSweeps: number): number {
  if (consecutiveFailedSweeps <= 0) return 0;
  return Math.min(
    UNMANAGED_PROBE_MS * 2 ** consecutiveFailedSweeps,
    UNMANAGED_PROBE_MAX_BACKOFF_MS,
  );
}

/** The timing half of a preview, which is what the dedupe compares. */
export interface UnmanagedClaimTiming {
  inWindow: boolean;
  /** `HH:MM` New York, when the claim next becomes live. */
  whenNy: string | null;
}

/** One rendered row of the strip. */
export interface UnmanagedPosition {
  accountId: number;
  accountName: string;
  contractId: string;
  side: "LONG" | "SHORT";
  size: number;
  /** True when the claim is live now, so the close is the next sweep. */
  inWindow: boolean;
  /** `HH:MM` New York, when the claim next becomes live. */
  whenNy: string | null;
}

/**
 * Whether a list of deployments means "keep running" or "stop".
 *
 * `"stop"` on an empty-or-all-settled list is what makes the caller's
 * freshness obligation real: fold a list one write stale, or a list that came
 * back empty from a failed read, and this answers `"stop"` — which tells the
 * engine to stand down over rows that are still Active. The predicate is
 * `isEngineManagedStatus`, so a leg mid-close still counts as running: the
 * engine owes it a flatten and must not be stopped out from under one.
 */
export function engineSyncIntent(deployments: readonly Deployment[]): "update" | "stop" {
  return deployments.some((d) => isEngineManagedStatus(d.status)) ? "update" : "stop";
}

/** The part of a probe the merge reads. `UnmanagedProbe` adds the request
 *  half on top. */
export interface UnmanagedProbeSubject {
  legId: string;
  accountId: number;
  accountName: string;
}

/** One probe per leg the engine will actually run. The key is the leg, not
 *  the account: two strategies can be armed on one account and each claims
 *  its own product root, so collapsing them would ask about one instrument
 *  and report the answer for both. */
export interface UnmanagedProbe extends UnmanagedProbeSubject {
  /** `BoardLeg.claim` verbatim — the adapter builds the preflight body, so
   *  nothing downstream reassembles one from a raw row. */
  target: BoardClaim;
}

/**
 * Which legs the strip may probe. **Two gates, not one.** `armed` mirrors
 * `isLegEngineEnabled`, which does not consult the live-account block — that
 * narrowing lives in `listManagedDeployments()` — so `armed` alone listed a
 * live-funded leg's hand position under a heading promising a close, on a
 * strip whose only job is that promise. A leg failing either gate will not
 * have its hand position closed and may not be listed as though it will.
 */
export function collectUnmanagedProbes(
  board: readonly BoardDeployment[],
): UnmanagedProbe[] {
  const out: UnmanagedProbe[] = [];
  for (const card of board) {
    for (const leg of card.legs) {
      if (!leg.armed || leg.autoTradeRefused) continue;
      out.push({
        legId: leg.id,
        accountId: leg.accountId,
        accountName: leg.accountName,
        target: leg.claim,
      });
    }
  }
  return out;
}

/** `HH:MM` → minutes past midnight, or null for anything that is not one. */
function nyMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Minutes from `nowNyMinutes` until the next `HH:MM`, wrapping midnight.
 * `null` for a claim with no stated time, which loses to any stated one.
 */
export function minutesUntilNy(whenNy: string | null, nowNyMinutes: number): number | null {
  if (whenNy == null) return null;
  const at = nyMinutes(whenNy);
  if (at == null) return null;
  return (((at - nowNyMinutes) % 1440) + 1440) % 1440;
}

/**
 * Does `candidate` describe what happens to this position sooner than
 * `held` does?
 *
 * Two deployments armed on one account and one product both claim the same
 * hand position, and it is one position — so one row wins, and the row has
 * to carry the timing the operator will actually see. An in-window claimer
 * wins outright: whatever else is true, that position goes on the next
 * sweep.
 *
 * **Between two out-of-window claimers the sooner one wins, and "sooner" is
 * not "lexicographically smaller".** The shipped version kept whichever came
 * first in board order, which is arbitrary. Comparing the `HH:MM` strings
 * instead is arbitrary in a worse way: at 10:00 New York, a claim at 09:30
 * is twenty-three and a half hours away and one at 17:00 is seven — the
 * string compare picks 09:30 and tells the operator their hand position
 * survives most of a day that it does not.
 */
export function preferUnmanagedClaim(
  held: UnmanagedClaimTiming,
  candidate: UnmanagedClaimTiming,
  nowNyMinutes: number,
): boolean {
  if (held.inWindow) return false;
  if (candidate.inWindow) return true;
  const heldIn = minutesUntilNy(held.whenNy, nowNyMinutes);
  const candidateIn = minutesUntilNy(candidate.whenNy, nowNyMinutes);
  if (candidateIn == null) return false;
  if (heldIn == null) return true;
  return candidateIn < heldIn;
}

/**
 * One sweep's answers folded into the rows the strip renders.
 *
 * **A probe that could not answer falls back to its own last answer**, and
 * that is the correction this function exists to hold. `null` is *"could not
 * answer"*, never *"nothing to close"* — which the sweep already knew within
 * a single pass, and did not know across passes: the all-failed guard catches
 * only total failure, and when 11 of 12 probes fail the row set was replaced
 * with what the one survivor found, silently deleting rows the other eleven
 * reported last time. **Partial failure is the likelier shape of the two** —
 * a per-account 401 or one stale contract id fails one probe, not twelve — so
 * this is the same rule the whole-sweep guard keeps, applied at probe scope.
 *
 * An empty `positions` on a *fresh* preview still clears the row: that is a
 * probe answering "nothing to close", which is the thing the strip is for.
 *
 * Dedupe is by `(accountId, contractId)` through `preferUnmanagedClaim`: two
 * strategies armed on one account and one product both claim the same hand
 * position, and it is one position. `now` is passed in so every comparison in
 * one merge is against one instant.
 */
export function mergeUnmanagedClaims(args: {
  answers: readonly { probe: UnmanagedProbeSubject; preview: ManualPositionPreview | null }[];
  lastAnswer: ReadonlyMap<string, ManualPositionPreview>;
  now: number;
}): UnmanagedPosition[] {
  const merged = new Map<string, UnmanagedPosition>();
  for (const { probe, preview: fresh } of args.answers) {
    const preview = fresh ?? args.lastAnswer.get(probe.legId);
    if (!preview) continue;
    for (const pos of preview.positions) {
      const key = `${probe.accountId}:${pos.contractId}`;
      const held = merged.get(key);
      if (held && !preferUnmanagedClaim(held, preview, args.now)) continue;
      merged.set(key, {
        accountId: probe.accountId,
        accountName: probe.accountName,
        contractId: pos.contractId,
        side: pos.side,
        size: pos.size,
        inWindow: preview.inWindow,
        whenNy: preview.whenNy,
      });
    }
  }
  return Array.from(merged.values()).sort(byAccountThenContract);
}

function byAccountThenContract(a: UnmanagedPosition, b: UnmanagedPosition): number {
  if (a.accountName !== b.accountName) return a.accountName < b.accountName ? -1 : 1;
  return a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0;
}

/**
 * New York wall-clock minutes past midnight, read once per sweep so every
 * comparison in one merge is against one instant.
 *
 * **The one known non-`HH:MM` output is converted, and anything else is
 * noisy.** `hour12: false` renders midnight as `24:00` on some ICU builds,
 * which `nyMinutes` rejects along with genuine garbage — so a single `?? 0`
 * fallback answered `00:00` for both. That is right for midnight and silent
 * for the other case, where it would measure every claim from midnight and
 * reorder the whole strip with nothing to see. The two are separated: `24:00`
 * is midnight, and a formatter this code does not recognise says so once
 * before falling back. (An earlier `% 1440` here was dead — `nyMinutes`
 * already refuses an hour above 23, so it never saw a value to reduce.)
 */
export function nowNyMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const at = nyMinutes(parts.startsWith("24:") ? `00:${parts.slice(3)}` : parts);
  if (at != null) return at;
  // Once per tab, not once per sweep. The trigger is a property of the
  // browser's ICU build, so the branch is either never taken or taken on
  // every sweep for the life of the tab — four a minute, forever.
  if (!warnedUnreadableClock) {
    warnedUnreadableClock = true;
    console.warn(
      `[board] unreadable New York clock reading "${parts}" — timings fall back to 00:00`,
    );
  }
  return 0;
}

let warnedUnreadableClock = false;

// ── What came back from a flatten ───────────────────────────────────────

const FORCE_FLAT_STATUSES: ReadonlySet<string> = new Set([
  "closed",
  "already_flat",
  "deferred",
  "error",
]);

const FLATTEN_ACTORS: ReadonlySet<string> = new Set([
  "watchdog",
  "d2",
  "session",
  "restart",
  "force_flat",
]);

/**
 * Narrow `POST /api/deployments/[id]/flatten`'s body, the way
 * `activation-prompts.ts` narrows the preflight's and for the same reason:
 * an `as` evaporates at runtime.
 *
 * The failure it prevents is the worst one this surface has. `(await
 * res.json()) as { result: ForceFlatResult }` over a body with no `result`
 * left `outcome` undefined, and by then the two-step arm had already
 * cleared and the error had already been reset — so an operator pressing
 * flatten on an open position got **nothing at all** back. A shape that does
 * not parse is the same fact as a request that never landed: nobody can say
 * what happened, and the position may still be open.
 *
 * `status` is the one required field beyond the id, because it is what
 * selects every sentence; the optional facts are copied only when they are
 * the type the surface reads them as. A field the server has not shipped yet
 * is absent, which is exactly what an older server sends.
 */
export function toForceFlatResult(raw: unknown): ForceFlatResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = (raw as Record<string, unknown>).result;
  if (typeof body !== "object" || body === null) return null;

  const r = body as Record<string, unknown>;
  if (typeof r.deploymentId !== "string") return null;
  if (typeof r.status !== "string" || !FORCE_FLAT_STATUSES.has(r.status)) return null;

  return {
    deploymentId: r.deploymentId,
    accountId: typeof r.accountId === "number" ? r.accountId : null,
    contractId: typeof r.contractId === "string" ? r.contractId : null,
    status: r.status as ForceFlatResult["status"],
    ...(typeof r.size === "number" ? { size: r.size } : {}),
    ...(typeof r.orderId === "number" ? { orderId: r.orderId } : {}),
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    ...(r.exitInFlight === true ? { exitInFlight: true as const } : {}),
    ...(r.positionMayStillBeOpen === true ? { positionMayStillBeOpen: true as const } : {}),
    ...(r.workingOrdersMayRemain === true ? { workingOrdersMayRemain: true as const } : {}),
    ...(typeof r.deferredTo === "string" && FLATTEN_ACTORS.has(r.deferredTo)
      ? { deferredTo: r.deferredTo as ForceFlatResult["deferredTo"] }
      : {}),
    ...(typeof r.retryAfterMs === "number" ? { retryAfterMs: r.retryAfterMs } : {}),
  };
}

// ── What a leg's dot is allowed to claim ────────────────────────────────

/**
 * The three things a leg's status dot may say.
 *
 * **The fill is semantic**, which is the shared primitive's own rule, so a
 * green fill claims *the engine will take an entry on this leg* and nothing
 * weaker. `armed` alone is not that claim: it mirrors `isLegEngineEnabled`,
 * which does not consult the live-account block — that narrowing happens in
 * `listManagedDeployments()`, one layer out — so a live-funded leg the engine
 * refuses to run pulsed **green** beside its own red `No Auto-Trade` chip.
 *
 * `autoTradeRefused` is read rather than `chip.kind`, and that is a
 * correctness choice of the same shape as `cardToggleIntent`'s: the chip is a
 * ladder, `detached` outranks the refusal, and a detached leg's account is
 * absent from the catalogue — `UNVERIFIED`, therefore refused — so the chip
 * would have said `detached` and the dot would have gone green on a row
 * nothing will ever trade.
 *
 * `closing` keeps its pulse because motion is what carries a transient state
 * here; the row is never greyed and its numbers never fade.
 */
export type LegPulse = "running" | "closing" | "idle";

export function legPulse(
  leg: Pick<BoardLeg, "armed" | "status" | "autoTradeRefused">,
): LegPulse {
  if (isClosingStatus(leg.status)) return "closing";
  if (leg.armed && !leg.autoTradeRefused) return "running";
  return "idle";
}

// ── A switched-off book's card is hidden, never lost ────────────────────

/**
 * Narrows `GET /api/groups`' `books` field, which decides what the Dashboard
 * hides — so everything it cannot read fails toward showing. Not a list:
 * `null`, and the caller treats it as no books (nothing hides) rather than
 * keeping a stale arming. A book with no readable switch is
 * dropped (an unnamed book's card stays); `playbooks` that is not a list is
 * left absent (unread, so every row stays) rather than iterated, which threw
 * inside the board's `useMemo`; an unreadable cell is dropped (its row stays).
 */
export function toBoardBooks(raw: unknown): BoardBook[] | null {
  if (!Array.isArray(raw)) return null;
  const books: BoardBook[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Record<string, unknown>;
    if (typeof b.id !== "string" || typeof b.enabled !== "boolean") continue;
    if (!Array.isArray(b.playbooks)) {
      books.push({ id: b.id, enabled: b.enabled });
      continue;
    }
    const playbooks: BoardBookCell[] = [];
    for (const cell of b.playbooks as unknown[]) {
      if (typeof cell !== "object" || cell === null) continue;
      const c = cell as Record<string, unknown>;
      if (typeof c.ticker !== "string" || typeof c.strategyKey !== "string") continue;
      if (typeof c.armed !== "boolean") continue;
      playbooks.push({ ticker: c.ticker, strategyKey: c.strategyKey, armed: c.armed });
    }
    books.push({ id: b.id, enabled: b.enabled, playbooks });
  }
  return books;
}

/**
 * The cards the Dashboard draws, and how many it left out.
 *
 * A book's derived rows cannot be deleted, so a book switched off would leave
 * a dead card on the board for good. `BoardDeployment.dormant` is the whole
 * rule and it is decided in `buildBoard`; this only applies it and **counts**,
 * because a filter that hides rows owes the number it hid
 * ([copy.md](../../docs/modules/ui/copy.md)).
 *
 * **A card that stays drops its dormant rows too** (`BoardLeg.dormant`, a
 * playbook off in its book and at rest), into a copy: the input board is not
 * touched, and the per-card count is keyed by card id. A dormant card's rows
 * are counted as the book, not again as playbooks.
 *
 * **Only the card list goes through this.** The session strip reads the
 * live-P&L hook and the unmanaged strip reads the full board, so neither can
 * lose a figure to a hidden card or row — and neither holds a position by its
 * own rule.
 */
export function boardVisibility(board: readonly BoardDeployment[]): {
  cards: BoardDeployment[];
  hiddenBookCount: number;
  /** Rows left off each shown card, by card id; a card hiding none is absent. */
  hiddenPlaybookCount: ReadonlyMap<string, number>;
} {
  const cards: BoardDeployment[] = [];
  const hiddenPlaybookCount = new Map<string, number>();
  for (const card of board) {
    if (card.dormant) continue;
    const legs = card.legs.filter((leg) => !leg.dormant);
    if (legs.length === card.legs.length) {
      cards.push(card);
      continue;
    }
    cards.push({ ...card, legs });
    hiddenPlaybookCount.set(card.id, card.legs.length - legs.length);
  }
  return { cards, hiddenBookCount: board.length - cards.length, hiddenPlaybookCount };
}

/** The nav's own label for the screen that holds a hidden book's switch. */
export const HIDDEN_BOOKS_LINK_LABEL = "Books";

/** The hidden-books line's tooltip: why they are not here, and that they exist. */
export const HIDDEN_BOOKS_DETAIL =
  "A book that is switched off, with nothing open and nothing needing attention, is left off the Dashboard. Nothing is deleted — its playbooks, its trade history and its switch are on Books.";

/** `2 books switched off · not shown`, or `null` when nothing is hidden. */
export function describeHiddenBooks(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "book" : "books"} switched off · not shown`;
}

/**
 * The hidden-playbooks line's tooltip. Two kinds of row hide under one count —
 * disarmed in the book, or a playbook this build does not include — and the
 * second has no switch on Books, so the sentence does not promise one.
 */
export const HIDDEN_PLAYBOOKS_DETAIL =
  "A playbook that is switched off in this book, or that this build does not include, is left off the card while it holds nothing and needs nothing.\n\n" +
  "Nothing is deleted — its trade history is kept, and a playbook is switched back on from Books.";

/** `4 playbooks off · not shown`, or `null` when the card hides none. */
export function describeHiddenPlaybooks(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "playbook" : "playbooks"} off · not shown`;
}

/** The body when every card is hidden — not *nothing is deployed*. */
export const BOARD_ALL_SWITCHED_OFF = "Nothing is switched on.";

// ── Empty is not error ──────────────────────────────────────────────────

/** `TradingState["status"]`, restated as what this module reads of it. */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "needsSetup"
  /** Never on screen with the board — the chrome shows the sign-in form
   *  instead — so it reads as any other unsettled connection. */
  | "signedOut";

/** What goes where the cards go. */
export type BoardBody =
  | { kind: "cards" }
  | { kind: "loading" }
  | { kind: "empty" }
  /** Deployments exist and every card is a switched-off book's, so hidden. */
  | { kind: "all-off" }
  | { kind: "unavailable" }
  /** Signed in with no broker: no account can be listed, by design. */
  | { kind: "no-broker" };

export interface BoardPresentation {
  body: BoardBody;
  /**
   * A banner above the cards, or null. Present whenever the board cannot
   * vouch for what it is showing — **including when there are cards on
   * screen**, because a list that stopped updating is not an empty one and
   * the operator has no other way to tell.
   */
  warning: string | null;
  /**
   * Whether the page-level Session P&L and Open count may render as numbers.
   *
   * **The same defect `boardSessionPnl` fixes, one component higher.** The
   * strip does not read that wrapper — it reads `allAccounts()` and
   * `openPositionCount()`, which reduce over `visibleAccounts`, and a
   * connection in `error` empties that list. An empty reduction is a
   * structurally valid zero, so the strip announced `$0.00` and `0 Open`
   * above a red banner with three positions open and every card beneath it
   * correctly showing em-dashes.
   *
   * It is **both channels answered**, not merely "neither broke", and it is
   * the same predicate the `empty` body is gated on: a session still
   * connecting and a store still loading each reduce over an empty set too,
   * and "not yet" is no more "flat" on the strip than it is on the body. The
   * count goes blind with the money because the Hard rule says they do — a
   * plausible zero on the field that says how much you are up or down is the
   * same defect as a plausible count on the field that says how much is at
   * risk.
   */
  totalsReadable: boolean;
}

export const BOARD_UNAVAILABLE_WARNING =
  "The deployment list could not be loaded, so this is not a reading of what is running. Reconnect or reload before acting on it.";

/** The session dropped. Names the connection, and only fires when the
 *  connection is what broke. */
export const BOARD_STALE_WARNING =
  "The connection dropped — these rows are the last ones that loaded and are no longer updating.";

/** The deployment list's own read failed while the session stayed up. **Two
 *  constants because they are two channels** — the module documents them as
 *  failing independently, and one sentence naming the connection over a
 *  healthy connection sends the operator to reconnect something that is not
 *  broken. */
export const BOARD_LIST_STALE_WARNING =
  "The deployment list could not be re-read, so these rows are the last ones that loaded and are no longer updating. The connection itself is up.";

/** The em-dash's reason on both strip figures. One sentence for both,
 *  because they go blind together and for one reason. */
export const BOARD_TOTALS_UNAVAILABLE =
  "No session reading — the board could not load the accounts this session is priced against, so this is not a total of zero. Reconnect or reload before acting on it.";

/**
 * Empty, loading and broken, told apart.
 *
 * **`buildBoard` answers `[]` for all three** — nothing deployed, the first
 * read not landed, and the refetch having 401'd — and on a board whose whole
 * job is saying what is running, rendering the third as *"nothing is
 * deployed"* is a worse lie than the *"no open positions"* it replaces: the
 * operator's conclusion is that nothing needs attention. This is the
 * *Dashboard auth-failure state* punchlist entry, respecified against the
 * board it was always going to land on.
 *
 * It reads **two** channels because the two fail independently. The session
 * (`/api/auth` → `/api/accounts`) is what `useTrading().status` reports; the
 * deployment list is its own store with its own read, and a 401 on the
 * refetch leaves the session still reading `connected`. Either one being
 * unable to answer means the board cannot claim the list is complete.
 *
 * Cards win over both: rows that loaded are still true of the moment they
 * loaded, so they render with the banner rather than being replaced by it.
 * Hiding a running deployment because the *next* read failed is the failure
 * this board exists to prevent, one turn later.
 *
 * **The same predicate also answers for the session strip**, which is why
 * `totalsReadable` is returned from here rather than recomputed at the
 * strip: a page with two readings of "can this board be trusted" is a page
 * where one of them is wrong.
 */
export function presentBoard(input: {
  connection: ConnectionStatus;
  deployments: DeploymentsLoadState;
  /** Cards on screen — `boardVisibility`'s, not the adapter's. */
  cardCount: number;
  /** Cards `boardVisibility` left out. Only read when none is on screen. */
  hiddenBookCount?: number;
  /** The session has no broker. With no card on screen the body says so in
   *  place of the account list, and the strip reads blind, not `$0.00`. */
  noBroker?: boolean;
}): BoardPresentation {
  const connectionBroken = input.connection === "error";
  const listBroken = input.deployments === "failed";
  const broken = connectionBroken || listBroken;
  // **Both channels answered**, which is stricter than "neither broke" and is
  // the same predicate the `empty` body below is gated on — for the same
  // reason. A session still connecting has an empty `visibleAccounts` and a
  // store still loading has an empty deployment list, and each reduces to a
  // structurally valid zero. "Not yet" is not "flat", on the strip exactly
  // as it is on the body.
  const totalsReadable = input.deployments === "ready" && input.connection === "connected";
  if (input.cardCount > 0) {
    return {
      body: { kind: "cards" },
      // The connection wins the wording when both are broken: it is the one
      // whose remedy — reconnect — also fixes the other.
      warning: connectionBroken
        ? BOARD_STALE_WARNING
        : listBroken
          ? BOARD_LIST_STALE_WARNING
          : null,
      totalsReadable,
    };
  }
  if (input.noBroker === true) {
    return { body: { kind: "no-broker" }, warning: null, totalsReadable: false };
  }
  if (broken) {
    return {
      body: { kind: "unavailable" },
      warning: BOARD_UNAVAILABLE_WARNING,
      totalsReadable,
    };
  }
  if (totalsReadable) {
    // *Nothing is deployed* is false over books that are merely switched off.
    const kind = (input.hiddenBookCount ?? 0) > 0 ? "all-off" : "empty";
    return { body: { kind }, warning: null, totalsReadable };
  }
  return { body: { kind: "loading" }, warning: null, totalsReadable };
}
