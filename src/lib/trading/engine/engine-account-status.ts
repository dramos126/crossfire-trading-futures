/**
 * The account status check: what each broker says about its catalogued
 * accounts' life — `ok`, `locked` or `dead` — written onto `account_brokers`
 * for the Settings Risk page to read.
 *
 * **Topstep's answer comes from its website's account record**
 * (`readTopstepTradingAccounts`, `GET userapi.topstepx.com/TradingAccount`):
 * `ineligible` is dead and a lockout is locked — plus what the record does
 * not show, laid over an `ok` by `withTopstepSearchLocks`: a daily-loss or
 * profit-target hit on a flat account and the search's `canTrade: false`
 * (locked), each with its cause — and a maximum-loss cause on a website
 * `dead`, which labels and refuses nothing more. Every stored change of
 * state or cause is logged once (`account_state_changed`). The documented
 * `onlyActiveAccounts` search cannot say this — it still lists failed and
 * ineligible accounts. An account the website omitted takes the search's
 * reading, and only one absent from both is dead. The website read is
 * undocumented, so it is optional: when it fails or its shape does not match,
 * the check falls back to the search's `canTrade` (listed and able to trade is
 * ok, listed and not is locked, unlisted dead), stores the website-only fields
 * as unknown — except that a fallback never revives a website `dead` nor
 * forgets a website OCO off (`recordAccountStates`) — and counts as unclean so
 * the hourly pass retries it.
 * **Tradovate is read off its search as before**: listed is ok, missing is
 * dead. See docs/modules/brokers/topstep.md.
 *
 * **A broker whose search did not answer writes nothing.** Its accounts keep
 * the status the last answering check gave them, so an outage can neither
 * hide every account nor bring a blown one back.
 *
 * **The status decides no exit, and this job decides nothing itself.** It is
 * read by the Risk list, by the account-state deploy gate, which refuses only a
 * create or re-arm (`account-state-gate.ts`), and by the engine's entry gate,
 * which skips a running deployment's new entries on a dead, locked or OCO-off
 * account (`engine-account-entry-gate.ts`); the engine's managed set is still
 * filtered by `autoTradeVerdict` alone. What the
 * engine does with an account that left the broker's list is the orphan pass,
 * which this check runs over its own refresh (`registryStatusFanOut`) — the
 * same per-arm pass `/api/deployments/check-orphans` runs, pausing that
 * account's deployments when its broker answered without it. Every refresh
 * also marks Tradovate's listed ids ok (`markAccountsActive`); every other
 * status write is this check's. Six triggers share one implementation — the
 * daily pass on the engine's clock (hourly while unclean), the 17:55 ET
 * evening pass, the post-open recheck of a lock with no end, a check ~10s
 * after a position closes, a check after a broker refuses an entry (so the
 * entry gate refuses the next signal off a fresh answer; never on a 429 or a
 * network error, and spaced), and
 * `POST /api/accounts/status` when Settings, the
 * Books screen or the Playbook Deploy picker opens — and a call that lands
 * while a check is running joins it rather than starting a second fan-out. Each check also stores Topstep's search balance, for the
 * Dashboard to show; nothing sizes or gates off it.
 *
 * A controller for the reason the close sampler is one: the in-flight promise,
 * the last-complete stamp and the failure throttles are written here and read
 * nowhere else.
 */
import {
  BrokerKind,
  accountStatesFromSearch,
  getAccountTradingIdentity,
  hasLockedAccountToRecheck,
  newlyDeadOf,
  recordAccountBalances,
  recordAccountStates,
  type AccountStateAnswer,
  type AccountStateTransition,
  type BrokerStatusAnswer,
} from "@/lib/db/account-brokers";
import type { AccountStateCause } from "@/lib/trading/broker-access/account-state-gate";
import {
  topstepStatusAnswer,
  type TopstepReadFailureKind,
  type TopstepTradingAccountsAnswer,
} from "@/lib/brokers/topstep/trading-account";
import type { RefreshResult } from "../broker-access/broker-registry";
import type { BrokerErrorKind } from "@/lib/brokers/plugin";
import { etDateKey, minutesInTradingTz } from "@/lib/trading/session/session-utils";
import { addCalendarDays, sessionDateOf, sessionStartUtc } from "@/lib/trading/regime/session-dates";
import { toCents } from "@/lib/trading/orders/pnl-math";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import { classifyAccount, type AccountClass } from "@/lib/brokers/topstep/account-classification";

/** How often the daily pass asks whether a day has gone by. A pass that finds
 *  one has not is a subtraction and a return; one whose last check had a
 *  broker fail or a website read fall back retries at this cadence rather
 *  than waiting a day. */
export const ACCOUNT_STATUS_JOB_INTERVAL_MS = 3_600_000;

/** How long a clean check stands: every configured broker answered and no
 *  fuller read fell back. */
export const ACCOUNT_STATUS_CHECK_PERIOD_MS = 86_400_000;

/** The evening pass's window opens at 17:55 ET, five minutes before the CME
 *  open, so the balance the Dashboard shows overnight is the day's last. */
export const ACCOUNT_STATUS_EVENING_START_MINUTES_ET = 17 * 60 + 55;
const CME_OPEN_MINUTES_ET = 18 * 60;

/** The post-open lock recheck's window: from a minute after the open, so
 *  Topstep has lifted a daily lock, for a quarter hour of retries. */
const OPEN_RECHECK_START_MINUTES_ET = CME_OPEN_MINUTES_ET + 1;
const OPEN_RECHECK_END_MINUTES_ET = CME_OPEN_MINUTES_ET + 15;

/** How often the evening pass asks whether it is inside its window — often
 *  enough to land inside five minutes; outside them a pass is two `Intl`
 *  reads and a return. */
export const ACCOUNT_STATUS_EVENING_INTERVAL_MS = 60_000;

/** How long after a position close the check runs, and the window further
 *  closes join: long enough for the broker's balance to carry the fill. */
export const ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS = 10_000;

/** How long after any check settles a rejected entry starts none. Longer than
 *  the shortest bar, so a rejection on every bar is not a fan-out per bar; a
 *  fresh rejection past it still re-reads before the next signal. */
export const ACCOUNT_STATUS_REJECTION_SPACING_MS = 5 * 60_000;

/** The kinds that mean the broker answered and refused this account's order.
 *  A 429, a timeout or a network error says nothing about the account. The
 *  watchdog reads the same set to tell a refused flatten from an unconfirmed
 *  one (A37). */
export const ENTRY_REFUSAL_KINDS: ReadonlySet<BrokerErrorKind> = new Set(["order_rejected", "account_unavailable"]);

/** A fallback, as the operator reads it in the log. */
const FALLBACK_KIND_TEXT: Record<TopstepReadFailureKind, string> = {
  "no-token": "no session token",
  expired: "session token expired",
  unauthorized: "token refused",
  http: "website error",
  network: "network error",
  shape: "answer changed shape",
};

/** One fan-out's searches: the ids each answering broker listed, those it
 *  listed as unable to trade, and when its search returned; and the brokers
 *  that were asked and did not answer. A broker in neither was not configured
 *  and was not asked. */
export interface AccountSearchFanOut {
  answered: ReadonlyMap<BrokerKind, SearchArm>;
  failed: readonly BrokerKind[];
}

interface SearchArm {
  ids: readonly number[];
  cannotTrade: readonly number[];
  at: string;
  /** The search's balance per listed id; null for a broker whose search
   *  carries none (Tradovate). */
  balances: ReadonlyMap<number, number> | null;
}

/** One answering broker's status answer, and its search's balances when the
 *  search carries any. */
export interface AnsweredBroker {
  answer: BrokerStatusAnswer;
  at: string;
  balances?: { values: ReadonlyMap<number, number>; at: string };
}

/** One fan-out, as the check writes it: each answering broker's whole answer
 *  with the time it was given, its search's balances with the time the search
 *  returned, the brokers that did not answer, and the brokers whose fuller
 *  read failed so the answer is the search's. */
export interface AccountStatusFanOut {
  answered: ReadonlyMap<BrokerKind, AnsweredBroker>;
  failed: readonly BrokerKind[];
  fallbacks: ReadonlyArray<{ broker: BrokerKind; kind: TopstepReadFailureKind; reason: string }>;
}

export interface AccountStatusCheckResult {
  checkedAt: string;
  answered: BrokerKind[];
  failed: BrokerKind[];
  /** Accounts this check moved to dead. */
  newlyDead: number[];
  /** Every configured broker answered and no fuller read fell back. */
  clean: boolean;
}

/**
 * Read a registry refresh as each broker's search answer, from the result
 * alone.
 *
 * `RefreshResult.errors` is null for an arm that answered **and** for an arm
 * that was never run because its broker is not configured, and those two must
 * not read the same here — taking an unconfigured arm's silence as an empty
 * answer would mark every one of its accounts dead. `listed` is what tells
 * them apart: non-null exactly for an arm that answered, fixed inside
 * `refresh()`. **Nothing here reads the live registry or the engine's client
 * handles**: both can be changed by a concurrent refresh after this result was
 * returned, which is how every Tradovate account could be recorded inactive.
 */
export function accountStatusFanOutOf(
  result: Pick<RefreshResult, "errors" | "listed" | "cannotTrade" | "answeredAt" | "balances">,
): AccountSearchFanOut {
  const answered = new Map<BrokerKind, SearchArm>();
  const failed: BrokerKind[] = [];
  for (const [kind, key] of [
    [BrokerKind.Topstep, "topstep"],
    [BrokerKind.Tradovate, "tradovate"],
  ] as const) {
    const ids = result.listed[key];
    const at = result.answeredAt[key];
    if (result.errors[key] !== null) failed.push(kind);
    else if (ids !== null && at !== null) {
      answered.set(kind, {
        ids,
        cannotTrade: result.cannotTrade[key] ?? [],
        at,
        balances: result.balances[key],
      });
    }
  }
  return { answered, failed };
}

export interface RegistryStatusFanOutDeps {
  /** The engine's `refreshBrokerRegistry()`. */
  refresh: () => Promise<RefreshResult>;
  /** The per-arm orphan pass `/api/deployments/check-orphans` runs, over the
   *  same result. */
  orphanAbsentAccounts: (result: RefreshResult) => Promise<void>;
  /** Topstep's website account read (`readTopstepTradingAccounts`). GET only,
   *  on the cached session token; asked only when Topstep's search answered. */
  readTopstepAccounts: () => Promise<TopstepTradingAccountsAnswer>;
  /** The engine's own open-or-pending position on the account, from its
   *  contract locks — the daily-loss and profit-target compares wait for flat. */
  hasOpenPosition: (accountId: number) => boolean;
  logEvent: (event: string, message: string) => void;
}

/**
 * The status check's fan-out as the engine builds it: one registry refresh,
 * the orphan pass over that refresh, each answering broker's search read off
 * its result, and — for Topstep — the website read that replaces it.
 *
 * **The orphan pass is here because the refresh resets the reconciler's
 * 30-minute clock**, and the reconciler only cross-checks a refresh it ran
 * itself — so without it, a status refresh is a fan-out nobody checks for
 * vanished accounts, and the next periodic pass is pushed half an hour out.
 * A pass that throws pauses nothing and is said once; the statuses are a
 * separate write and still land.
 */
export function registryStatusFanOut(
  deps: RegistryStatusFanOutDeps,
): () => Promise<AccountStatusFanOut> {
  return async () => {
    const result = await deps.refresh();
    try {
      await deps.orphanAbsentAccounts(result);
    } catch (err) {
      deps.logEvent(
        "orphan_check_skipped",
        `Account-status orphan check failed and paused nothing: ${errorText(err)}`,
      );
    }
    const search = accountStatusFanOutOf(result);
    const answered = new Map<BrokerKind, AnsweredBroker>();
    const fallbacks: Array<{ broker: BrokerKind; kind: TopstepReadFailureKind; reason: string }> = [];
    for (const [kind, arm] of search.answered) {
      const fromSearch = accountStatesFromSearch(arm.ids, arm.cannotTrade);
      // The balance is the search's whichever answer the status takes, and it
      // is stamped when the search returned.
      const balances = arm.balances === null ? undefined : { values: arm.balances, at: arm.at };
      if (kind === BrokerKind.Topstep) {
        const website = await deps.readTopstepAccounts().catch(
          (err): TopstepTradingAccountsAnswer => ({ ok: false, kind: "network", reason: errorText(err) }),
        );
        if (website.ok) {
          const merged = websiteOverSearch(topstepStatusAnswer(website.accounts, website.at), fromSearch);
          answered.set(kind, {
            answer: withTopstepSearchLocks(
              merged,
              {
                balances: arm.balances,
                balanceAt: arm.at,
                cannotTrade: arm.cannotTrade,
                accountClass: catalogueAccountClass,
                hasOpenPosition: deps.hasOpenPosition,
              },
              website.at,
            ),
            at: website.at,
            balances,
          });
          continue;
        }
        fallbacks.push({ broker: kind, kind: website.kind, reason: website.reason });
      }
      answered.set(kind, { answer: fromSearch, at: arm.at, balances });
    }
    return { answered, failed: search.failed, fallbacks };
  };
}

/**
 * The website's answer, plus the search's reading for every account the search
 * listed and the website omitted. A website answer missing a listed account is
 * not evidence the account is dead — the record may be filtered or late — so
 * that account keeps the search's coarser answer (source `search`, facts
 * unknown), and only one absent from both is dead.
 */
function websiteOverSearch(website: BrokerStatusAnswer, search: BrokerStatusAnswer): BrokerStatusAnswer {
  const named = new Set(website.accounts.map((a) => a.accountId));
  return {
    source: website.source,
    accounts: [...website.accounts, ...search.accounts.filter((a) => !named.has(a.accountId))],
  };
}

/** What the same refresh's Topstep search said, beside the website answer. */
export interface TopstepSearchReading {
  /** The search's balance per listed id; null when it carried none. */
  balances: ReadonlyMap<number, number> | null;
  /** When the search returned — the balance's time. */
  balanceAt: string;
  /** The ids the search listed with `canTrade: false`. */
  cannotTrade: readonly number[];
  /** Each account's class off the catalogue (`classifyAccount`); the daily
   *  loss rule reads `COMBINE` alone, the profit-target rule `COMBINE` and
   *  `XFA`. */
  accountClass: (accountId: number) => AccountClass;
  /** Whether the engine holds an open or pending position on the account —
   *  read at the compare, so a close landing during the fan-out counts. */
  hasOpenPosition: (accountId: number) => boolean;
}

/**
 * How long after the 18:00 ET open a search balance is not compared with
 * `startOfDayBalance`. When Topstep rolls that figure to the new session is
 * unobserved: a balance read at 18:01 against the closed session's
 * start-of-day figure would re-lock an account Topstep just unlocked, and the
 * clean check behind it would leave the lock standing for a day.
 */
export const DAILY_LOSS_OPEN_SETTLE_MS = 30 * 60_000;

/** Every renderer puts a lock reason in parentheses mid-sentence, so these are
 *  phrases: lower-case, no closing period. */
export const CANNOT_TRADE_LOCK_REASON = "Topstep's account list says it cannot trade right now";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const usd = (cents: number) => USD.format(cents / 100);

export function dailyLossLockReason(lostCents: number, limitCents: number): string {
  return `daily loss limit reached: lost ${usd(lostCents)} of a ${usd(limitCents)} limit today`;
}

export function profitTargetLockReason(gainedCents: number, targetCents: number): string {
  return `daily profit target reached: up ${usd(gainedCents)} on a ${usd(targetCents)} target today`;
}

export function maxLossReason(balanceCents: number, floorCents: number): string {
  return `maximum loss limit reached: balance ${usd(balanceCents)} is at or under its ${usd(floorCents)} floor`;
}

/**
 * The locks the website record does not show, read off the website's own
 * facts and the search this check just ran. Applied to an account the
 * website read `ok`; a website `dead` is only labelled (below), and a running
 * website lockout is never touched.
 *
 * **Maximum loss is a label, never a refusal.** A website `dead` whose search
 * balance is at or under its `maximumLoss` floor, in whole cents, takes cause
 * `max-loss` and the breach's phrase; its state stays the website's. A
 * website `ok` is never made dead by it.
 *
 * **Both balance compares below wait for a flat account** (`hasOpenPosition`):
 * the search balance is realized only, and Topstep's limits count open P&L.
 * The after-close check re-runs them once the last position closes.
 *
 * **Daily loss.** Topstep's website record kept an account `ok`, no lockout,
 * after its Daily Loss Limit locked it (observed 2026-10-21). So an account
 * whose search balance is at least the smallest positive of `dailyLoss` and
 * `personalDailyLossLimit` under `startOfDayBalance` reads `locked` until the
 * next 18:00 ET open — when Topstep lifts it, the gates stop reading it, and
 * the post-open recheck re-reads it. In whole cents, exact at the limit. Only
 * a Combine (evaluation) account: elsewhere a payout or withdrawal drops the
 * balance with the start-of-day figure unchanged. A balance read before the
 * current session's 18:00 open plus `DAILY_LOSS_OPEN_SETTLE_MS` is not
 * compared — the start-of-day figure may belong to the other session. Cause
 * `daily-loss`, whichever of the two limits is the smaller.
 *
 * **Profit target — Combine and XFA.** Failing that, a search balance at least
 * a positive `personalDailyProfitTarget` over `startOfDayBalance` reads
 * `locked`, cause `profit-target`, until the next open, under the same two
 * session guards. A payout lowers the balance, so it cannot trip this one;
 * practice never reads it.
 *
 * **Cannot trade.** Failing that, an account the search lists with
 * `canTrade: false` reads `locked` with no end — except while no session is
 * live (the 17:00–18:00 ET halt, Friday 17:00 to Sunday 18:00), when Topstep
 * refuses orders anyway and the flag may say only that. There the account is
 * marked `holdStoredLock`, so a stored lock stands rather than being written
 * `ok` and re-locked at the open.
 */
export function withTopstepSearchLocks(
  answer: BrokerStatusAnswer,
  search: TopstepSearchReading,
  at: string,
): BrokerStatusAnswer {
  const now = new Date(at);
  // `currentCmeSessionStart` answers the next open whenever no session is live.
  const sessionLive = Date.parse(currentCmeSessionStart(now)) <= now.getTime();
  const refused = new Set(sessionLive ? search.cannotTrade : []);
  const balanceComparable =
    Date.parse(search.balanceAt) >=
    sessionStartUtc(tradingSessionDateOf(now)).getTime() + DAILY_LOSS_OPEN_SETTLE_MS;
  const accounts = answer.accounts.map((a): AccountStateAnswer => {
    if (a.source !== "website") return a;
    const balance = search.balances?.get(a.accountId);
    if (a.state === "dead") {
      const breach = balance === undefined ? null : maxLossHit(a, balance);
      return breach === null
        ? a
        : { ...a, cause: "max-loss", lockoutReason: maxLossReason(breach.balanceCents, breach.floorCents) };
    }
    if (a.state !== "ok") return a;
    const accountClass = search.accountClass(a.accountId);
    const evaluated = accountClass === "COMBINE" || accountClass === "XFA";
    // The search balance is realized only, while Topstep's limits count open
    // P&L: with a leg open, realized can cross a limit that net has not.
    const comparable = balanceComparable && balance !== undefined && !search.hasOpenPosition(a.accountId);
    const dll = comparable && accountClass === "COMBINE" ? dailyLossHit(a, balance) : null;
    if (dll !== null) {
      return {
        ...a,
        state: "locked",
        cause: "daily-loss",
        lockoutReason: dailyLossLockReason(dll.lostCents, dll.limitCents),
        lockoutUntil: nextSessionOpen(now).toISOString(),
      };
    }
    const target = comparable && evaluated ? profitTargetHit(a, balance) : null;
    if (target !== null) {
      return {
        ...a,
        state: "locked",
        cause: "profit-target",
        lockoutReason: profitTargetLockReason(target.gainedCents, target.targetCents),
        lockoutUntil: nextSessionOpen(now).toISOString(),
      };
    }
    if (refused.has(a.accountId)) {
      return {
        ...a,
        state: "locked",
        cause: "cannot-trade",
        lockoutReason: CANNOT_TRADE_LOCK_REASON,
        lockoutUntil: null,
      };
    }
    // Ignored outside a session, the flag is no evidence the account can
    // trade either: a stored lock stands rather than flapping through `ok`.
    if (!sessionLive && search.cannotTrade.includes(a.accountId)) return { ...a, holdStoredLock: true };
    return a;
  });
  return { ...answer, accounts };
}

function maxLossHit(
  a: AccountStateAnswer,
  balance: number,
): { balanceCents: number; floorCents: number } | null {
  const floor = a.facts?.maximumLossUsd;
  if (floor == null || !Number.isFinite(floor) || floor <= 0 || !Number.isFinite(balance)) return null;
  const balanceCents = toCents(balance);
  const floorCents = toCents(floor);
  return balanceCents <= floorCents ? { balanceCents, floorCents } : null;
}

function profitTargetHit(
  a: AccountStateAnswer,
  balance: number,
): { gainedCents: number; targetCents: number } | null {
  const sod = a.facts?.startOfDayBalanceUsd;
  const target = a.facts?.personalDailyProfitTargetUsd;
  if (sod == null || target == null || !Number.isFinite(sod) || !Number.isFinite(target)) return null;
  if (target <= 0 || !Number.isFinite(balance)) return null;
  const gainedCents = toCents(balance) - toCents(sod);
  const targetCents = toCents(target);
  return gainedCents >= targetCents ? { gainedCents, targetCents } : null;
}

function dailyLossHit(
  a: AccountStateAnswer,
  balance: number,
): { lostCents: number; limitCents: number } | null {
  const sod = a.facts?.startOfDayBalanceUsd;
  if (sod == null || !Number.isFinite(sod) || !Number.isFinite(balance)) return null;
  const limits = [a.facts?.dailyLossUsd, a.facts?.personalDailyLossLimitUsd]
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0)
    .map(toCents);
  if (limits.length === 0) return null;
  const limitCents = Math.min(...limits);
  const lostCents = toCents(sod) - toCents(balance);
  return lostCents >= limitCents ? { lostCents, limitCents } : null;
}

/** An account's class from its catalogued name, through the live-account
 *  block's own classifier; an account the catalogue cannot classify is
 *  `UNKNOWN`, which no rule here acts on. */
function catalogueAccountClass(accountId: number): AccountClass {
  const identity = getAccountTradingIdentity(accountId);
  return identity === null ? "UNKNOWN" : classifyAccount(identity);
}

/** The session date `at` trades in, or — in the weekend gap — the one that
 *  just closed: a Saturday or Sunday session date has no session. */
function tradingSessionDateOf(at: Date): string {
  let day = sessionDateOf(at);
  while (!isWeekday(day)) day = addCalendarDays(day, -1);
  return day;
}

/** The first 18:00 ET open after the session `at` belongs to — Sunday's for a
 *  Friday session or the weekend gap. */
function nextSessionOpen(at: Date): Date {
  let day = addCalendarDays(tradingSessionDateOf(at), 1);
  while (!isWeekday(day)) day = addCalendarDays(day, 1);
  return sessionStartUtc(day);
}

export interface AccountStatusJobDeps {
  /** One account fan-out, consumed as a result — the engine never calls a
   *  broker client itself. */
  fanOut: () => Promise<AccountStatusFanOut>;
  logEvent: (event: string, message: string, subject?: { accountId: number }) => void;
}

/** The event a stored state change is said under. */
export const ACCOUNT_STATE_CHANGED_EVENT = "account_state_changed";

/** A cause as the log names it, where the stored reason is not to hand. */
const CAUSE_TEXT: Record<AccountStateCause, string> = {
  "daily-loss": "daily loss limit",
  "profit-target": "daily profit target",
  "max-loss": "maximum loss limit",
  website: "reported by Topstep's website",
  "cannot-trade": "Topstep's account list says it cannot trade",
};

const LOG_LOCK_END_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function stateWithCause(state: string, cause: AccountStateCause | null): string {
  return cause === null ? state : `${state} (${CAUSE_TEXT[cause]})`;
}

/**
 * One stored state change, as the operator reads it: the account, what it
 * was, what it is now and why, with the figures and the lock's end. The full
 * id goes in and the pipe truncates it to `…4469`.
 */
export function accountStateChangeMessage(t: AccountStateTransition): string {
  const was = t.from.state === null ? "never checked" : stateWithCause(t.from.state, t.from.cause);
  if (t.to.state === "ok") return `Account ${t.accountId} went from ${was} to ok.`;
  const why = t.to.reason?.trim() || (t.to.cause === null ? null : CAUSE_TEXT[t.to.cause]);
  const until = t.to.until === null ? NaN : Date.parse(t.to.until);
  const end =
    t.to.state === "dead"
      ? ""
      : Number.isNaN(until)
        ? ", with no end time given"
        : ` until ${LOG_LOCK_END_FORMAT.format(new Date(until))} ET`;
  return `Account ${t.accountId} went from ${was} to ${t.to.state}${why ? ` (${why})` : ""}${end}.`;
}

export class AccountStatusJob {
  private inFlight: Promise<AccountStatusCheckResult> | null = null;
  /** When the last clean check completed — no broker failed and no fuller
   *  read fell back. Null until one has, so the first daily pass after a start
   *  always checks. */
  private lastCompleteAt: number | null = null;
  /** When the last check of any trigger settled, clean, unclean or thrown —
   *  the rejected-entry trigger's spacing. */
  private lastSettledAt: number | null = null;
  /** The failed-broker set last reported, so a broker that stays down costs
   *  one line rather than one per hourly retry. Cleared by a clean check. */
  private reportedFailure: string | null = null;
  /** The fallback set last reported, keyed on kind, on the same throttle.
   *  Cleared by a check with no fallback. */
  private reportedFallback: string | null = null;
  /** Fallbacks seen per broker and kind since the process started, said or
   *  throttled, so prod shows how often each happens. Six kinds per broker
   *  bound it. */
  private fallbackCounts = new Map<string, number>();
  /** The ET date the evening pass last ran for, so it runs once a day. */
  private lastEveningFor: string | null = null;
  /** The ET date the post-open lock recheck last ran for. */
  private lastOpenRecheckFor: string | null = null;
  /** The pending after-close check, while closes are still landing. */
  private afterCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by `cancelPending()` (the engine's `stop()`), cleared by `arm()`: a
   *  close booked after a stop schedules nothing. */
  private disarmed = false;

  constructor(private deps: AccountStatusJobDeps) {}

  /**
   * The evening pass: one check at or after 17:55 ET, before the 18:00 open,
   * on each weekday — the days a session closes at 17:00. Runs whether or not
   * the hourly pass thinks a check is due, because what it buys is a balance
   * read after the day's last fill.
   */
  async runEveningPass(now: Date = new Date()): Promise<void> {
    const minutes = minutesInTradingTz(now);
    if (minutes < ACCOUNT_STATUS_EVENING_START_MINUTES_ET || minutes >= CME_OPEN_MINUTES_ET) return;
    const day = etDateKey(now);
    if (!isWeekday(day) || this.lastEveningFor === day) return;
    await this.oncePerDay(day, "lastEveningFor");
  }

  /**
   * The post-open lock recheck: one check between 18:01 and 18:15 ET on each
   * day a session opens at 18:00 (Sunday to Thursday), and only while some
   * stored account is `locked` with no end time or an end already past — a
   * search `canTrade: false` lock, or the daily-loss lock that ends at the
   * open. Topstep lifts both at the open, and nothing else would re-read them
   * until the next hourly pass found a check due.
   */
  async runOpenRecheck(now: Date = new Date()): Promise<void> {
    const minutes = minutesInTradingTz(now);
    if (minutes < OPEN_RECHECK_START_MINUTES_ET || minutes >= OPEN_RECHECK_END_MINUTES_ET) return;
    const day = etDateKey(now);
    if (!opensAt1800(day) || this.lastOpenRecheckFor === day) return;
    if (!hasLockedAccountToRecheck(now.toISOString())) return;
    await this.oncePerDay(day, "lastOpenRecheckFor");
  }

  /**
   * Stamp the day before the first `await`, so a slow check is not re-entered
   * by the next tick inside the window — and take the stamp back when the
   * check threw or was unclean, so the window's remaining ticks retry it.
   */
  private async oncePerDay(day: string, stamp: "lastEveningFor" | "lastOpenRecheckFor"): Promise<void> {
    this[stamp] = day;
    try {
      const result = await this.check();
      if (!result.clean) this[stamp] = null;
    } catch (err) {
      this[stamp] = null;
      throw err;
    }
  }

  /** Re-arm the after-close trigger — the engine's start. */
  arm(): void {
    this.disarmed = false;
  }

  /**
   * A position closed: check `ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS` from now,
   * and a close inside that wait restarts it, so a flatten of several legs is
   * one check. **Synchronous, and nothing it schedules can throw back**: it is
   * called from the exit-booking path, which it must never block or fail. A
   * check that throws is said and changes nothing. A no-op while disarmed.
   */
  noteTradeClosed(): void {
    if (this.disarmed) return;
    if (this.afterCloseTimer !== null) clearTimeout(this.afterCloseTimer);
    this.afterCloseTimer = setTimeout(() => {
      this.afterCloseTimer = null;
      if (this.disarmed) return;
      this.check().catch((err: unknown) => {
        this.deps.logEvent(
          "boot_broker_arm_failed",
          `Account status check after a position close threw: ${errorText(err)} — accounts keep ` +
            `the status and balance the last check gave them`,
        );
      });
    }, ACCOUNT_STATUS_AFTER_CLOSE_DELAY_MS);
  }

  /**
   * The broker refused an entry: check now, so the account entry gate refuses
   * the next signal off a fresh answer. Only on a refusal (`kind` is the
   * owning broker's classification, null when no broker owns the error), and
   * none within `ACCOUNT_STATUS_REJECTION_SPACING_MS` of the last check
   * settling. Synchronous and never throws back, like `noteTradeClosed`; a
   * no-op while disarmed.
   */
  noteEntryRejected(kind: BrokerErrorKind | null, accountId: number): void {
    if (this.disarmed || kind === null || !ENTRY_REFUSAL_KINDS.has(kind)) return;
    if (this.inFlight) return;
    if (this.lastSettledAt !== null && Date.now() - this.lastSettledAt < ACCOUNT_STATUS_REJECTION_SPACING_MS) {
      return;
    }
    this.check().catch((err: unknown) => {
      this.deps.logEvent(
        "boot_broker_arm_failed",
        `Account status check after a rejected entry on account ${accountId} threw: ${errorText(err)} — ` +
          `accounts keep the status the last check gave them`,
        { accountId },
      );
    });
  }

  /** Drop a pending after-close check and disarm the trigger until `arm()` —
   *  `stop()`'s half of this job. A check already running completes. */
  cancelPending(): void {
    this.disarmed = true;
    if (this.afterCloseTimer !== null) clearTimeout(this.afterCloseTimer);
    this.afterCloseTimer = null;
  }

  /** Check now. A check already running is joined, not repeated. */
  check(): Promise<AccountStatusCheckResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.run().finally(() => {
      this.inFlight = null;
      this.lastSettledAt = Date.now();
    });
    this.inFlight = run;
    return run;
  }

  /** The clock's entry point: checks when no clean check has completed in the
   *  last day, including one the Settings page triggered. */
  async runDailyPass(now: Date = new Date()): Promise<void> {
    if (
      this.lastCompleteAt !== null &&
      now.getTime() - this.lastCompleteAt < ACCOUNT_STATUS_CHECK_PERIOD_MS
    ) {
      return;
    }
    await this.check();
  }

  private async run(): Promise<AccountStatusCheckResult> {
    const fanOut = await this.deps.fanOut();
    const settledAt = new Date();
    const checkedAt = settledAt.toISOString();
    const newlyDead: number[] = [];
    // Each row is stamped when its broker answered, not when this check
    // settled: the orphan pass runs in between, and a later stamp would let
    // this answer outrank a refresh that listed the account since.
    for (const [broker, { answer, at, balances }] of fanOut.answered) {
      const transitions = recordAccountStates(broker, answer, at);
      newlyDead.push(...newlyDeadOf(transitions));
      for (const t of transitions) {
        this.deps.logEvent(ACCOUNT_STATE_CHANGED_EVENT, accountStateChangeMessage(t), {
          accountId: t.accountId,
        });
      }
      if (balances !== undefined) recordAccountBalances(broker, balances.values, balances.at);
    }
    const failed = [...fanOut.failed];
    if (failed.length === 0) {
      this.reportedFailure = null;
    } else {
      this.reportFailure(failed);
    }
    // A fallback is unclean like a failed broker: the read never mints, so a
    // stale cached token only clears on a later pass, and the hourly retry is
    // what gets there before tomorrow. An unclean check after a clean one
    // clears the stamp, or the hourly pass would wait out the clean one's day.
    const clean = failed.length === 0 && fanOut.fallbacks.length === 0;
    this.lastCompleteAt = clean ? settledAt.getTime() : null;
    this.reportFallbacks(fanOut.fallbacks);
    return { checkedAt, answered: [...fanOut.answered.keys()], failed, newlyDead, clean };
  }

  private reportFailure(failed: readonly BrokerKind[]): void {
    const key = [...failed].sort().join(",");
    if (this.reportedFailure === key) return;
    this.reportedFailure = key;
    this.deps.logEvent(
      "boot_broker_arm_failed",
      `Account status check: ${failed.join(" and ")} did not answer, so ` +
        `${failed.length === 1 ? "its" : "their"} accounts keep the status the last check gave them.`,
    );
  }

  /** The website read is undocumented and may break without notice, so its
   *  failure is said — once per distinct kind, not once per hourly retry —
   *  with the kind and its running count. */
  private reportFallbacks(fallbacks: AccountStatusFanOut["fallbacks"]): void {
    const counts = fallbacks.map((f) => {
      const countKey = `${f.broker}:${f.kind}`;
      const count = (this.fallbackCounts.get(countKey) ?? 0) + 1;
      this.fallbackCounts.set(countKey, count);
      return count;
    });
    if (fallbacks.length === 0) {
      this.reportedFallback = null;
      return;
    }
    const key = fallbacks.map((f) => `${f.broker}:${f.kind}`).join(",");
    if (this.reportedFallback === key) return;
    this.reportedFallback = key;
    fallbacks.forEach((f, i) => {
      this.deps.logEvent(
        "boot_broker_arm_failed",
        `Account status check: ${f.broker}'s website account read failed ` +
          `(${FALLBACK_KIND_TEXT[f.kind]}: ${f.reason}; ${ordinal(counts[i] ?? 1)} time since the engine started), so ` +
          `its accounts were checked against the account search instead — an account that cannot trade reads ` +
          `as locked, an account already read as dead or with OCO off stays so, and OCO, auto-bracket ` +
          `and prefill figures are otherwise unknown until the read works. ` +
          `It is retried hourly.`,
      );
    });
  }
}

const SATURDAY = 6;
const SUNDAY = 0;

const FRIDAY = 5;

function dayOfWeek(etDate: string): number {
  return new Date(`${etDate}T12:00:00Z`).getUTCDay();
}

function isWeekday(etDate: string): boolean {
  const dow = dayOfWeek(etDate);
  return dow !== SATURDAY && dow !== SUNDAY;
}

/** Sunday to Thursday: the days a CME session opens at 18:00 ET. */
function opensAt1800(etDate: string): boolean {
  const dow = dayOfWeek(etDate);
  return dow !== FRIDAY && dow !== SATURDAY;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
