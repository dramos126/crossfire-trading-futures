/**
 * The account-state deploy gate: may a deployment be created or re-armed on
 * this account **right now**, given what its broker last said about it?
 *
 * **It sits beside `autoTradeVerdict`, never inside it.** That predicate asks
 * a fixed question of an account's identity — is it a class this platform may
 * auto-trade at all — and the engine's managed set is filtered on it, so a
 * refusal there withholds every row on the account from the engine, open
 * positions included. This one asks a question that changes by the hour —
 * failed, locked out, OCO switched off — and refuses only the *start* of
 * something: an account that dies under an `Active` deployment keeps it in the
 * engine, which is what manages an open position out. Folding the two into one
 * predicate would make every lockout drop a live position out of the exit loop.
 * Both are asked by the one deploy screen, `screenAccountsForAutoTrade`, live
 * account first ([brokers/README.md](../../../../docs/modules/brokers/README.md)).
 *
 * DB-free, like `account-trading-policy.ts`, so the sentences are importable
 * anywhere; the persisted-state adapter is `getAccountDeployState` in
 * `db/account-brokers.ts`.
 */

/**
 * Why an account is `locked` or `dead`, when the status check can tell: a
 * Topstep daily loss limit (Combine's own or the personal one), a personal
 * daily profit target, the maximum-loss floor, Topstep's own website record
 * (lockout or ineligible, with its reason text), or the account search's
 * `canTrade: false`. Null is unknown — and always on an `ok`. It changes only
 * the stamp and the reason sentence, never whether the gate refuses.
 */
export type AccountStateCause = "daily-loss" | "profit-target" | "max-loss" | "website" | "cannot-trade";

export function parseAccountStateCause(raw: string | null): AccountStateCause | null {
  return raw === "daily-loss" ||
    raw === "profit-target" ||
    raw === "max-loss" ||
    raw === "website" ||
    raw === "cannot-trade"
    ? raw
    : null;
}

/** What the gate reads about one account — `account_brokers`' status and the
 *  website facts, every field null when unknown. */
export interface AccountDeployState {
  broker: "topstep" | "tradovate";
  /** Null is never checked. */
  status: "ok" | "locked" | "dead" | null;
  cause: AccountStateCause | null;
  /** The lock's reason phrase — or, on a `max-loss` dead, the breach's. */
  lockoutReason: string | null;
  /** ISO instant, or null when none was said or it could not be read. */
  lockoutUntil: string | null;
  /** Topstep's website OCO setting. Null is unknown — the website read failed,
   *  fell back, or never ran. */
  autoOcoBrackets: boolean | null;
  bracketAutoApply: boolean | null;
  bracketRiskUsd: number | null;
  bracketTargetUsd: number | null;
}

export type AccountStateRefusalKind = "dead" | "locked" | "oco-off" | "oco-unknown";

export type AccountStateVerdict =
  /** `warning` is said beside the deploy and blocks nothing. */
  | { permitted: true; warning: string | null }
  | { permitted: false; kind: AccountStateRefusalKind; stamp: string; reason: string };

// ── Copy ────────────────────────────────────────────────────────────────

export const ACCOUNT_DEAD_REFUSAL =
  "This account can no longer trade: its broker reports it failed, ineligible or closed. " +
  "Use another account.";

/** Operator's wording (proposal topstep-account-state.md), verbatim. */
export const AUTO_OCO_OFF_REFUSAL =
  "Auto OCO Brackets is off for this account in Topstep. Turn it on in Topstep's settings, then try again.";

/** The setting was never read, so it is refused as if off — the operator's
 *  answer 4. It clears on the next account check that reads Topstep's website:
 *  the engine retries hourly while the read fails, and opening Settings runs
 *  one. Also lands in the book reconciler's log lines, so it names no screen
 *  to reopen. */
export const AUTO_OCO_UNKNOWN_REFUSAL =
  "Auto OCO Brackets could not be checked for this account in Topstep, so nothing can be " +
  "deployed on it yet. This clears once an account check reads it: one runs every hour, " +
  "and opening Settings runs one now.";

/** The refused-row stamp per kind, in the `no auto-trade` stamp's shape.
 *  Title Case with acronyms upper case, rendered as written — the class
 *  carries no `uppercase` (copy.md). */
export const ACCOUNT_STATE_STAMP: Record<AccountStateRefusalKind, string> = {
  dead: "Dead",
  locked: "Locked",
  "oco-off": "OCO Off",
  "oco-unknown": "OCO Unknown",
};

/** The stamp that replaces `Locked` / `Dead` when the cause is known. Each
 *  applies only on the kind its cause produces; any other cause keeps the
 *  kind's stamp. */
export const ACCOUNT_STATE_CAUSE_STAMP = {
  "daily-loss": "DLL",
  "profit-target": "Profit Target",
  "max-loss": "Max Loss",
} as const satisfies Partial<Record<AccountStateCause, string>>;

export function accountStateStamp(kind: AccountStateRefusalKind, cause: AccountStateCause | null): string {
  if (kind === "locked" && (cause === "daily-loss" || cause === "profit-target")) {
    return ACCOUNT_STATE_CAUSE_STAMP[cause];
  }
  if (kind === "dead" && cause === "max-loss") return ACCOUNT_STATE_CAUSE_STAMP[cause];
  return ACCOUNT_STATE_STAMP[kind];
}

/** The warn stamp beside an account whose Topstep auto-bracket is on. */
export const AUTO_BRACKET_STAMP = "topstep bracket";

const LOCK_END_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** A dead account's sentence: the breach's own figures when the status check
 *  read a maximum-loss breach, the broker's report otherwise. */
export function deadRefusal(cause: AccountStateCause | null, reason: string | null): string {
  const breach = deadBreachPhrase(cause, reason);
  return breach === null ? ACCOUNT_DEAD_REFUSAL : `This account can no longer trade (${breach}). Use another account.`;
}

/** The phrase a dead account's sentences name instead of "its broker reports
 *  it failed": the maximum-loss breach's, when that is what was read. Shared
 *  by the deploy refusal and the engine's entry-skip line. */
export function deadBreachPhrase(cause: AccountStateCause | null, reason: string | null): string | null {
  return cause === "max-loss" && reason != null && reason.trim() !== "" ? reason.trim() : null;
}

export function lockedRefusal(reason: string | null, until: Date | null): string {
  const why = reason != null && reason.trim() !== "" ? ` (${reason.trim()})` : "";
  return until != null
    ? `This account is locked out${why} until ${LOCK_END_FORMAT.format(until)} ET. ` +
        `Try again after that.`
    : `This account is locked out${why}, and its broker did not say until when. ` +
        `Try again once the lock is lifted.`;
}

export function autoBracketWarning(riskUsd: number | null, targetUsd: number | null): string {
  const bracket =
    riskUsd != null && targetUsd != null
      ? `its own ${WHOLE_DOLLARS.format(riskUsd)} stop and ${WHOLE_DOLLARS.format(targetUsd)} target`
      : "its own stop and target";
  return (
    `Topstep's auto bracket is on for this account, so Topstep attaches ${bracket} to every ` +
    `entry, on top of the engine's. Turn it off in Topstep's settings unless you want both.`
  );
}

// ── The verdict ─────────────────────────────────────────────────────────

/**
 * Dead, then locked, then the OCO setting — the order in which a fix exists:
 * a dead account has none, a lock clears by waiting, OCO by a setting.
 *
 * **The OCO arm is Topstep's alone.** Tradovate brackets are OSO orders and
 * the broker has no such setting, so a Tradovate account is never refused on
 * it, whatever the column reads.
 *
 * A never-checked status (`null`) refuses nothing by itself; on Topstep the
 * OCO arm then refuses it as unknown, which is the operator's rule.
 */
export function accountStateVerdict(state: AccountDeployState, now: Date): AccountStateVerdict {
  const refuse = (kind: AccountStateRefusalKind, reason: string): AccountStateVerdict => ({
    permitted: false,
    kind,
    stamp: accountStateStamp(kind, state.cause),
    reason,
  });
  if (state.status === "dead") return refuse("dead", deadRefusal(state.cause, state.lockoutReason));
  if (state.status === "locked") {
    const until = lockEnd(state.lockoutUntil);
    // A lock whose stated end has passed is over; the next check stores `ok`.
    if (until == null || until.getTime() > now.getTime()) {
      return refuse("locked", lockedRefusal(state.lockoutReason, until));
    }
  }
  if (state.broker === "topstep") {
    if (state.autoOcoBrackets === false) return refuse("oco-off", AUTO_OCO_OFF_REFUSAL);
    if (state.autoOcoBrackets == null) return refuse("oco-unknown", AUTO_OCO_UNKNOWN_REFUSAL);
  }
  return {
    permitted: true,
    warning:
      state.bracketAutoApply === true
        ? autoBracketWarning(state.bracketRiskUsd, state.bracketTargetUsd)
        : null,
  };
}

function lockEnd(iso: string | null): Date | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// ── Move to replacement ─────────────────────────────────────────────────

/** The control's label, on the grid's row and the picker's. */
export const MOVE_TO_REPLACEMENT_LABEL = "Move to replacement";

/** `POST /api/deployments/move-account`'s three refusals and its rolled-back
 *  write, rendered verbatim. */
export const MOVE_NEEDS_A_DEAD_ACCOUNT =
  "Only a dead account's book and deployments can be moved to a replacement.";

export const MOVE_TARGET_NOT_A_REPLACEMENT =
  "That account is not a replacement for this one. A replacement is on the same Topstep " +
  "program and starting balance, can trade, and has no book or deployment of its own.";

export const MOVE_WAITS_FOR_OPEN_TRADE =
  "A deployment on this account still has a trade open or a close in progress. Wait for it " +
  "to finish, then move.";

export const MOVE_DID_NOT_LAND =
  "Nothing was moved. The book and its deployments are still on the old account. Open " +
  "the account again and retry.";

/** The control's title: what one press does, naming the target. */
export function moveToReplacementTitle(target: string): string {
  return (
    `Moves this account's book and deployments to ${target}, which is on the same Topstep ` +
    `program and unused. Each keeps its on or off state, and one paused because the account ` +
    `went missing comes back on if its book is on.\n\n` +
    `Your risk per trade, max contracts, daily limits and account phase come along where ` +
    `${target} has none. Set its maximum loss limit and starting balance on the Risk page in Settings, ` +
    `where Topstep's figures are suggested.`
  );
}

/** One catalogued account, as the replacement match reads it. */
export interface ReplacementPoolEntry {
  accountId: number;
  name: string | null;
  status: AccountDeployState["status"];
  templateId: number | null;
  startingBalanceUsd: number | null;
  /** Both gates — the live-account block and {@link accountStateVerdict}. */
  deployable: boolean;
}

/**
 * The accounts a dead one's book and deployments may move to: `ok`, on the
 * same program — same `templateId` **and** same starting balance, both known —
 * passing every deploy gate, and used by nothing. A reset hands out a new
 * account number on the same program, which is the case this exists for.
 *
 * Empty when the dead account's program is unknown: a guess would move a
 * 150K's playbooks onto a 50K. The dollar compare is an equality on two
 * values the broker reported, never arithmetic.
 */
export function replacementCandidates(
  dead: Pick<ReplacementPoolEntry, "accountId" | "templateId" | "startingBalanceUsd">,
  pool: readonly ReplacementPoolEntry[],
  inUse: ReadonlySet<number>,
): Array<{ accountId: number; name: string | null }> {
  if (dead.templateId == null || dead.startingBalanceUsd == null) return [];
  return pool
    .filter(
      (a) =>
        a.accountId !== dead.accountId &&
        a.status === "ok" &&
        a.deployable &&
        a.templateId === dead.templateId &&
        a.startingBalanceUsd === dead.startingBalanceUsd &&
        !inUse.has(a.accountId),
    )
    .map((a) => ({ accountId: a.accountId, name: a.name }));
}
