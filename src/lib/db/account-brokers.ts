import { getDb, registerMigration } from "./connection";
import {
  autoTradeVerdict,
  type AccountTradingIdentity,
  type AutoTradeVerdict,
} from "@/lib/trading/broker-access/account-trading-policy";
import { refreshManagedAccounts, setManagedAccountSource } from "@/lib/logging/scrub";
import {
  REVIEWED_MAX_CONTRACTS,
  type AccountRiskPosture,
} from "@/lib/trading/orders/risk-sizer";
import {
  parseAccountRiskPhase,
  resolveSessionBudget,
  type AccountRiskPhase,
  type SessionBudget,
  type SessionBudgetRow,
} from "@/lib/trading/orders/account-phase-sizer";
import { log } from "@/lib/logger";
import {
  ACCOUNT_RISK_SETTINGS_CHANGED,
  accountRiskChangeMessage,
  describeAccountRiskChange,
  type AccountRiskSettings,
} from "./account-risk-change";
import type { DailyPnlLimits } from "@/lib/trading/daily-pnl-gate";
import {
  accountStateVerdict,
  parseAccountStateCause,
  type AccountDeployState,
  type AccountStateCause,
} from "@/lib/trading/broker-access/account-state-gate";
import type { Account } from "@/lib/brokers/types";

/**
 * Per-account broker discriminator. Persists the `account_id → broker`
 * mapping the runtime broker registry rebuilds on every engine boot.
 *
 * The runtime registry (src/lib/trading/broker-access/broker-registry.ts)
 * is the source of truth at engine runtime — every `searchAccounts`
 * fan-out upserts here so:
 *   - API routes that don't hold an engine reference (groups POST,
 *     deployments POST) can validate broker uniformity without booting
 *     a full client.
 *   - The "is this broker expected" predicate behind the boot-failure
 *     alert can ask "do any deployments target a Tradovate-broker
 *     account?" without a live broker fetch.
 *   - The live-account auto-trade block can classify an account from an
 *     `accountId` alone. Deployment rows carry no account name and there
 *     is no `accounts` table, so `account_name` + `practice` here are the
 *     only persisted record of what an account is.
 *
 * Existing rows (pre-Phase-4 installs) stay implicitly Topstep —
 * `getAccountBrokerOrTopstep` returns `'topstep'` for unknown ids. New
 * accounts get tagged on first sight by the registry refresh.
 */

/** The status's companions. Declared above the migration because it reads
 *  them. Every one nullable with no DEFAULT. */
const BROKER_STATE_COLUMNS = [
  ["broker_status_source", "TEXT"],
  ["broker_status_code", "INTEGER"],
  ["broker_lockout_reason", "TEXT"],
  ["broker_lockout_until", "TEXT"],
  ["broker_auto_oco", "INTEGER"],
  ["broker_bracket_auto_apply", "INTEGER"],
  ["broker_bracket_risk_usd", "REAL"],
  ["broker_bracket_target_usd", "REAL"],
  ["broker_starting_balance_usd", "REAL"],
  ["broker_max_loss_floor_usd", "REAL"],
  ["broker_highest_balance_usd", "REAL"],
  ["broker_sod_balance_usd", "REAL"],
  ["broker_daily_loss_limit_usd", "REAL"],
  ["broker_personal_dll_usd", "REAL"],
  ["broker_personal_profit_target_usd", "REAL"],
  ["broker_stage", "INTEGER"],
  ["broker_template_id", "INTEGER"],
  ["broker_state_cause", "TEXT"],
] as const;

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS account_brokers (
      account_id INTEGER PRIMARY KEY,
      broker TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // `account_name` + `practice` carry the two facts the auto-trade block
  // needs and the table never held: Topstep's account class is derived
  // from the name, and there is no `accounts` table to read one from.
  // Both are nullable on purpose — a row seeded before this migration has
  // neither, and a NOT NULL DEFAULT would make "legacy row" indistinguishable
  // from "genuinely not practice". `getAccountTradingIdentity` reads NULL
  // as unknown, and unknown is refused.
  const cols = d.prepare(`PRAGMA table_info(account_brokers)`).all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("account_name")) d.exec(`ALTER TABLE account_brokers ADD COLUMN account_name TEXT`);
  if (!has("practice")) d.exec(`ALTER TABLE account_brokers ADD COLUMN practice INTEGER`);
  // The risk posture: what one entry on this account may lose at its stop,
  // and the contract ceiling regardless of that budget. Both nullable with
  // **no default**, for the reason the two columns above are — a column that
  // decides what the engine does gets no DEFAULT, because the ALTER writes
  // it to every existing row before anything can look at them. NULL is "the
  // operator has not set a posture", `resolveRiskSizedContracts` throws on
  // it, and the engine skips the tick. A `DEFAULT 250` would arm every
  // account in the catalogue at a number nobody chose.
  if (!has("max_risk_per_trade_usd")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN max_risk_per_trade_usd REAL`);
  }
  if (!has("max_contracts")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN max_contracts INTEGER`);
  }
  // The ceiling's *value* is reviewed even though its storage is per account,
  // so a row written while the reviewed number was higher is brought under it
  // here rather than clamped at read: one number decides the size, and it is
  // the stored one the operator can see on the form. Behind an EXISTS probe
  // for the reason the trade-label backfill is — every block re-runs on every
  // boot, and the steady state should be one query rather than an UPDATE.
  const overCeiling = d
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM account_brokers WHERE max_contracts > ?) AS hit`,
    )
    .get(REVIEWED_MAX_CONTRACTS) as { hit: number };
  if (overCeiling.hit === 1) {
    d.prepare(`UPDATE account_brokers SET max_contracts = ? WHERE max_contracts > ?`).run(
      REVIEWED_MAX_CONTRACTS,
      REVIEWED_MAX_CONTRACTS,
    );
  }
  // The daily P&L gate, re-scoped from the deployment to the account: Topstep's
  // daily loss is an account rule and per-deployment scoping was an artifact of
  // the deployment being the only config object there was. Nullable with no
  // DEFAULT for the same reason as the two above, but read the *opposite* way:
  // NULL here means "no gate", which is what `0` meant on the retired
  // `CommonParams` keys and is the state every account starts in. A gate that
  // blocked entries because its number was unset would stop an account trading
  // on a setting the operator never touched.
  if (!has("daily_max_loss_usd")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN daily_max_loss_usd REAL`);
  }
  if (!has("daily_max_profit_usd")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN daily_max_profit_usd REAL`);
  }
  if (!has("daily_pnl_include_unrealized")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN daily_pnl_include_unrealized INTEGER`);
  }
  // The account phase and the close sample the phase-aware budget is computed
  // from. Nullable with no DEFAULT like everything above, and NULL takes a
  // *third* reading here: `risk_phase` NULL is **inherit** — phase `off`,
  // today's flat posture, byte-for-byte — which is neither the posture's
  // refuse nor the daily gate's off. The four operator-declared columns are
  // the route's to write; the four sample columns are `recordSessionClose`'s,
  // and no seed upsert may name any of the eight.
  if (!has("risk_phase")) d.exec(`ALTER TABLE account_brokers ADD COLUMN risk_phase TEXT`);
  if (!has("mll_usd")) d.exec(`ALTER TABLE account_brokers ADD COLUMN mll_usd REAL`);
  if (!has("start_balance_usd")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN start_balance_usd REAL`);
  }
  if (!has("payout_taken_at")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN payout_taken_at TEXT`);
  }
  if (!has("eod_balance_usd")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN eod_balance_usd REAL`);
  }
  if (!has("eod_peak_usd")) d.exec(`ALTER TABLE account_brokers ADD COLUMN eod_peak_usd REAL`);
  if (!has("eod_sizes_session_start")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN eod_sizes_session_start TEXT`);
  }
  if (!has("eod_recorded_at")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN eod_recorded_at TEXT`);
  }
  // `combine_press`'s headroom threshold. NULL reads as *refuse*, only in the
  // phase that needs it — the `mll_usd` reading — and every other phase
  // ignores it. Operator-declared, so the route's to write and never the seed's.
  if (!has("press_at_usd")) d.exec(`ALTER TABLE account_brokers ADD COLUMN press_at_usd REAL`);
  // What the broker last said about the account's life — `ok`, `locked` or
  // `dead` — as of the last status check that heard from its broker. NULL is
  // *never checked* and reads as listed: the Risk page hides an account only
  // on a broker's answer, never on a missing one. The seed upsert never names
  // either column.
  if (!has("broker_status")) d.exec(`ALTER TABLE account_brokers ADD COLUMN broker_status TEXT`);
  if (!has("broker_status_checked_at")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN broker_status_checked_at TEXT`);
  }
  // The first cut stored `active` / `inactive`; the same two answers are now
  // `ok` / `dead`. One UPDATE that matches nothing once the rows are moved.
  d.exec(
    `UPDATE account_brokers
        SET broker_status = CASE broker_status WHEN 'active' THEN 'ok' ELSE 'dead' END
      WHERE broker_status IN ('active', 'inactive')`,
  );
  // Where the status came from, the lock behind a `locked`, and what Topstep's
  // website reported about the account. Written with the status, by the same
  // writers, under the same answer-time guard. NULL is a fifth reading,
  // *unknown*: the website did not answer, or this broker has no such field —
  // never `false`, because a later gate on `broker_auto_oco` must not read a
  // fallback as "OCO off".
  for (const [name, type] of BROKER_STATE_COLUMNS) {
    if (!has(name)) d.exec(`ALTER TABLE account_brokers ADD COLUMN ${name} ${type}`);
  }
  // The balance the broker's account search last reported, and when the
  // search answered. Display only — nothing sizes or gates off it. NULL is
  // *unknown*: never read, or a broker whose search carries no balance.
  if (!has("broker_balance_usd")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN broker_balance_usd REAL`);
  }
  if (!has("broker_balance_at")) {
    d.exec(`ALTER TABLE account_brokers ADD COLUMN broker_balance_at TEXT`);
  }
});

export const enum BrokerKind {
  Topstep = "topstep",
  Tradovate = "tradovate",
}

interface AccountBrokerRow {
  account_id: number;
  broker: string;
  updated_at: string;
  account_name: string | null;
  practice: number | null;
  max_risk_per_trade_usd: number | null;
  max_contracts: number | null;
  daily_max_loss_usd: number | null;
  daily_max_profit_usd: number | null;
  daily_pnl_include_unrealized: number | null;
  risk_phase: string | null;
  mll_usd: number | null;
  start_balance_usd: number | null;
  payout_taken_at: string | null;
  eod_balance_usd: number | null;
  eod_peak_usd: number | null;
  eod_sizes_session_start: string | null;
  eod_recorded_at: string | null;
  press_at_usd: number | null;
  broker_status: string | null;
  broker_status_checked_at: string | null;
  broker_status_source: string | null;
  broker_status_code: number | null;
  broker_lockout_reason: string | null;
  broker_lockout_until: string | null;
  broker_auto_oco: number | null;
  broker_bracket_auto_apply: number | null;
  broker_bracket_risk_usd: number | null;
  broker_bracket_target_usd: number | null;
  broker_starting_balance_usd: number | null;
  broker_max_loss_floor_usd: number | null;
  broker_highest_balance_usd: number | null;
  broker_sod_balance_usd: number | null;
  broker_daily_loss_limit_usd: number | null;
  broker_personal_dll_usd: number | null;
  broker_personal_profit_target_usd: number | null;
  broker_stage: number | null;
  broker_template_id: number | null;
  broker_state_cause: string | null;
  broker_balance_usd: number | null;
  broker_balance_at: string | null;
}

/**
 * What the last status check heard about an account from its broker: it can
 * trade (`ok`), it is temporarily locked out (`locked`), or it can never trade
 * again (`dead` — failed, ineligible, or no longer reported at all).
 */
export type AccountBrokerStatus = "ok" | "locked" | "dead";

/** Which answer a status came from: Topstep's website account record, or a
 *  documented account search (every Tradovate answer, and Topstep's fallback). */
export type AccountStatusSource = "website" | "search";

/** An account's last checked status. `state` null is *never checked*. */
export interface AccountStatusRecord {
  state: AccountBrokerStatus | null;
  checkedAt: string | null;
  source: AccountStatusSource | null;
  /** The broker's own status code (Topstep's `status`), null when unknown. */
  statusCode: number | null;
  lockoutReason: string | null;
  /** ISO instant the lockout ends, null when none or not said. */
  lockoutUntil: string | null;
}

/**
 * What Topstep's website reported about an account beyond its status: the OCO
 * and auto-bracket settings a deploy gate reads, and the numbers a Risk prefill
 * suggests. Present only on a website-sourced answer; a fallback stores none
 * of it, so every column reads NULL — unknown, not false. Any one field may be
 * null on a website answer too: the website left it null or out.
 */
export interface BrokerAccountFacts {
  autoOcoBrackets: boolean | null;
  bracketAutoApply: boolean | null;
  bracketAmountToRiskUsd: number | null;
  bracketAmountToMakeUsd: number | null;
  startingBalanceUsd: number | null;
  maximumLossUsd: number | null;
  highestBalanceUsd: number | null;
  startOfDayBalanceUsd: number | null;
  dailyLossUsd: number | null;
  personalDailyLossLimitUsd: number | null;
  personalDailyProfitTargetUsd: number | null;
  stage: number | null;
  templateId: number | null;
}

/** One account in one broker's answer. `source` is per account because a
 *  website answer carries the search's reading for an account it omitted. */
export interface AccountStateAnswer {
  accountId: number;
  source: AccountStatusSource;
  state: AccountBrokerStatus;
  /** Why a `locked` or `dead` is so, when the answer can tell; null on `ok`. */
  cause: AccountStateCause | null;
  statusCode: number | null;
  /** A lock's reason phrase, or a `max-loss` dead's breach phrase. */
  lockoutReason: string | null;
  lockoutUntil: string | null;
  facts: BrokerAccountFacts | null;
  /** Keep a stored `locked` — its cause, reason and end — rather than this
   *  answer's state: set where the answer cannot tell (Topstep's
   *  `canTrade: false` outside a session). The facts are still written. */
  holdStoredLock?: boolean;
}

/** One account's status as stored before and after a `recordAccountStates`
 *  write that changed it. `from.state` null is never checked. */
export interface AccountStateTransition {
  accountId: number;
  from: { state: AccountBrokerStatus | null; cause: AccountStateCause | null };
  to: {
    state: AccountBrokerStatus;
    cause: AccountStateCause | null;
    reason: string | null;
    until: string | null;
  };
}

/** The whole of one broker's answer. A catalogued account of that broker
 *  missing from `accounts` is recorded `dead`, under the answer's `source`. */
export interface BrokerStatusAnswer {
  source: AccountStatusSource;
  accounts: readonly AccountStateAnswer[];
}

function parseAccountBrokerStatus(raw: string | null): AccountBrokerStatus | null {
  return raw === "ok" || raw === "locked" || raw === "dead" ? raw : null;
}

function parseAccountStatusSource(raw: string | null): AccountStatusSource | null {
  return raw === "website" || raw === "search" ? raw : null;
}

function statusRecordOf(r: AccountBrokerRow): AccountStatusRecord {
  return {
    state: parseAccountBrokerStatus(r.broker_status),
    checkedAt: r.broker_status_checked_at,
    source: parseAccountStatusSource(r.broker_status_source),
    statusCode: r.broker_status_code,
    lockoutReason: r.broker_lockout_reason,
    lockoutUntil: r.broker_lockout_until,
  };
}

/**
 * Read a documented account search as a status answer: a listed account is
 * `ok` unless the search said it cannot trade, which reads `locked` with no
 * reason and no end. This is all a Tradovate answer says (its search lists
 * only `active` accounts, so none is in `cannotTrade`), and it is Topstep's
 * reading when its website read fails or omits an account — where
 * `canTrade: false` covers a violation and a lockout alike. `locked` keeps a
 * lockout listed on Risk; a violation is caught dead by the next website read.
 */
export function accountStatesFromSearch(
  listedIds: readonly number[],
  cannotTrade: readonly number[],
): BrokerStatusAnswer {
  const refused = new Set(cannotTrade);
  return {
    source: "search",
    accounts: listedIds.map((accountId) => ({
      accountId,
      source: "search",
      state: refused.has(accountId) ? "locked" : "ok",
      cause: refused.has(accountId) ? "cannot-trade" : null,
      statusCode: null,
      lockoutReason: null,
      lockoutUntil: null,
      facts: null,
    })),
  };
}

/** One account as reported by a broker's `searchAccounts` fan-out. */
export interface AccountBrokerSeed {
  accountId: number;
  broker: BrokerKind;
  name: string;
  practice: boolean;
}

/**
 * Map a `searchAccounts` fan-out into seed rows.
 *
 * Every fan-out site upserts the catalog, and this is the mapping they
 * share. It lived inline in three of them — `/api/accounts`,
 * `runBootSequence` and `BrokerRegistry.refresh()` — as verbatim copies
 * with an invariant and no seam, which is the shape that shipped the
 * open-position gate's dead arm. A fourth fan-out calls this.
 *
 * `Account.broker` is the literal union, not `BrokerKind`, so each copy
 * carried an `as BrokerKind` cast. Narrowed here instead. Be precise
 * about what that buys: the ternary **normalises**, it does not reject —
 * any non-`"tradovate"` string becomes Topstep, silently, exactly as a
 * cast would. What it guarantees is that the write side narrows the same
 * way the read side does, so nothing can be persisted as a value
 * `getAccountBrokerOrNull` would not read back. Do not cite this as a
 * guard against a third broker; it is not one.
 */
export function toAccountBrokerSeeds(
  accounts: readonly Pick<Account, "id" | "broker" | "name" | "practice">[],
): AccountBrokerSeed[] {
  return accounts.map((a) => ({
    accountId: a.id,
    broker: a.broker === "tradovate" ? BrokerKind.Tradovate : BrokerKind.Topstep,
    name: a.name,
    practice: a.practice,
  }));
}

/**
 * Returns the broker kind persisted for an account, or `'topstep'` for
 * unknown ids. The default-to-Topstep behavior preserves byte-identical
 * routing for every existing install (no Tradovate-broker rows exist
 * before the operator opts in). The name spells the default out so a
 * future caller checking `=== 'tradovate'` doesn't mistake "unknown"
 * for "is Topstep".
 */
export function getAccountBrokerOrTopstep(accountId: number): BrokerKind {
  return getAccountBrokerOrNull(accountId) ?? BrokerKind.Topstep;
}

/**
 * Same lookup with the default withheld: `null` means "this account has
 * no row", not "this account is Topstep".
 *
 * Safety paths need this. On the open-position gate, defaulting an
 * untagged id to Topstep asks a Topstep client about what may be a
 * Tradovate account — it answers `positions: []` and the gate opens on a
 * live position. That is reachable: a `BrokerRegistry.refresh()` whose
 * Tradovate arm throws leaves new Tradovate accounts untagged. Anywhere a
 * wrong answer is worse than no answer, read this and decide explicitly.
 */
export function getAccountBrokerOrNull(accountId: number): BrokerKind | null {
  const row = getDb()
    .prepare(`SELECT broker FROM account_brokers WHERE account_id = ?`)
    .get(accountId) as AccountBrokerRow | undefined;
  if (!row) return null;
  return row.broker === "tradovate" ? BrokerKind.Tradovate : BrokerKind.Topstep;
}

/**
 * The seed upsert. **Its `DO UPDATE SET` names the four catalogue columns and
 * must never name the two posture columns.**
 *
 * This statement runs on every boot, on every `BrokerRegistry.refresh()` and
 * on every `/api/accounts` fan-out, from a `searchAccounts` response that
 * knows nothing about risk. An `excluded.max_risk_per_trade_usd` here would
 * null the operator's budget on the next page load, and the failure is silent
 * until an entry signal arrives and the sizer throws. The three daily-P&L
 * columns are in the same position and fail more quietly still — a nulled
 * daily loss limit is a gate that stops firing, which looks like a good day.
 * A new column on this table belongs in this list only if a broker fan-out is
 * what produces it.
 *
 * **Nor may it name any of the nine phase columns**, and the close sample is
 * the one that has to be argued for rather than assumed: it *is* produced by
 * a broker fan-out, but by the close-timed one (`recordSessionClose`), so an
 * `excluded.eod_balance_usd` here would let any page load overwrite a
 * yesterday-stamped close with a mid-session balance. An
 * `excluded.risk_phase` would flip an opted-in account back to `off`.
 *
 * **Nor the status columns or their companions.** A fan-out does produce
 * them, but the seed only ever hears about the accounts a broker *listed* — it
 * cannot say which ones went missing, and on Topstep a listed account may be
 * dead. `recordAccountStates` is handed the whole of one broker's answer and
 * writes every account of it; `markAccountsActive` writes Tradovate's listed
 * half from a registry refresh. Kept out of this statement so a seed site
 * cannot write a status by accident.
 */
const UPSERT_SQL = `INSERT INTO account_brokers (account_id, broker, updated_at, account_name, practice)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(account_id) DO UPDATE SET
     broker = excluded.broker,
     updated_at = excluded.updated_at,
     account_name = excluded.account_name,
     practice = excluded.practice`;

/**
 * Upsert one account. Takes the whole seed rather than `(id, broker)`:
 * a row written without a name is one the auto-trade block cannot
 * classify, so it would refuse to trade that account.
 */
export function setAccountBroker(seed: AccountBrokerSeed): void {
  getDb()
    .prepare(UPSERT_SQL)
    .run(seed.accountId, seed.broker, new Date().toISOString(), seed.name, seed.practice ? 1 : 0);
  refreshManagedAccounts();
}

/**
 * Bulk variant for the broker-registry refresh and boot-seed paths. Wraps
 * the upserts in a single SQLite transaction so a 100-account fan-out is
 * one DB roundtrip instead of N.
 */
export function setAccountBrokers(entries: Iterable<AccountBrokerSeed>): void {
  const db = getDb();
  const stmt = db.prepare(UPSERT_SQL);
  const now = new Date().toISOString();
  const tx = db.transaction((rows: AccountBrokerSeed[]) => {
    for (const r of rows) stmt.run(r.accountId, r.broker, now, r.name, r.practice ? 1 : 0);
  });
  tx(Array.from(entries));
  refreshManagedAccounts();
}

/**
 * Record one broker's whole answer about its accounts' life: every catalogued
 * account of that broker takes the state its answer gives it, and one the
 * answer does not mention is `dead`. Stamped `checkedAt`, with the source, the
 * lock and — from Topstep's website — the reported facts; an answer without
 * facts writes every fact column NULL, so a fallback reads as *unknown*.
 *
 * **Call it only with a broker that answered.** A broker whose search threw
 * said nothing about its accounts, and the caller writes nothing for it — so
 * a failed check leaves the last known status in place rather than hiding
 * every account or reviving a blown one. An empty answer from a broker that
 * answered is a real answer (every account closed) and is written.
 *
 * Updates and never inserts, like every non-seed writer here, and never
 * deletes: a dead account's row stays, because `strategy_trades`,
 * `deployments` and the book tables all hold its id. An answer naming an id
 * the catalogue does not hold under this broker is ignored.
 *
 * **`checkedAt` is when the broker gave the answer, and an older answer never
 * overwrites a newer one** — see {@link STATUS_IS_OLDER}.
 *
 * **A search answer never loosens what the website last said** — Topstep's
 * fallback, over a row its website answered. A website `dead` stays whole and
 * only its stamp moves: the search lists Ineligible accounts able to trade, so
 * its word would revive one. And a website OCO *off* stays `0` while every
 * other fact goes NULL: a fallback over an off would otherwise read unknown,
 * which the engine's entry gate lets trade. An *on* still goes NULL, so the
 * deploy gate refuses it as unknown until the website answers again. And a
 * website-sourced `locked` whose end is still ahead — a lockout, or the
 * daily-loss lock the check lays over a website `ok` — stays whole while the
 * search still lists the account: the search reads it `ok`, and would unlock
 * it early. One the search omits is dead as before. A kept row keeps its
 * cause with it.
 *
 * **Returns each account whose state or cause this write changed**, read
 * against the row it replaced inside the same transaction — what the check
 * logs. A row kept whole (stamp only) is no change, nor is a rewrite of the
 * same state and cause with fresh figures, so a check that finds nothing new
 * returns nothing; nor is a cause filled in where none was stored under the
 * same state. Two things are kept rather than overwritten: a stored `locked`
 * an answer marks `holdStoredLock`, and a stored `max-loss` cause (with its
 * phrase) on an account that stays `dead`. A never-checked row becoming `ok` is not one either: the
 * first check after a boot would otherwise name every account. The ids that
 * moved to `dead` are `newlyDeadOf` the result.
 */
export function recordAccountStates(
  broker: BrokerKind,
  answer: BrokerStatusAnswer,
  checkedAt: string,
): AccountStateTransition[] {
  const db = getDb();
  const byId = new Map(answer.accounts.map((a) => [a.accountId, a]));
  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT account_id, broker_status, broker_status_source, broker_auto_oco, broker_lockout_reason,
                broker_lockout_until, broker_state_cause
           FROM account_brokers
          WHERE broker = ? AND ${STATUS_IS_OLDER}
          ORDER BY account_id`,
      )
      .all(broker, checkedAt) as Array<
      Pick<
        AccountBrokerRow,
        | "account_id"
        | "broker_status"
        | "broker_status_source"
        | "broker_auto_oco"
        | "broker_lockout_reason"
        | "broker_lockout_until"
        | "broker_state_cause"
      >
    >;
    const stampOnly = db.prepare(
      `UPDATE account_brokers SET broker_status_checked_at = ? WHERE account_id = ?`,
    );
    const update = db.prepare(
      `UPDATE account_brokers
          SET broker_status = ?, broker_status_checked_at = ?, broker_status_source = ?,
              broker_status_code = ?, broker_lockout_reason = ?, broker_lockout_until = ?,
              broker_auto_oco = ?, broker_bracket_auto_apply = ?,
              broker_bracket_risk_usd = ?, broker_bracket_target_usd = ?,
              broker_starting_balance_usd = ?, broker_max_loss_floor_usd = ?,
              broker_highest_balance_usd = ?,
              broker_sod_balance_usd = ?, broker_daily_loss_limit_usd = ?,
              broker_personal_dll_usd = ?, broker_personal_profit_target_usd = ?,
              broker_stage = ?, broker_template_id = ?, broker_state_cause = ?
        WHERE account_id = ?`,
    );
    const transitions: AccountStateTransition[] = [];
    for (const row of rows) {
      const overWebsite = answer.source === "search" && row.broker_status_source === "website";
      if (overWebsite && row.broker_status === "dead") {
        stampOnly.run(checkedAt, row.account_id);
        continue;
      }
      const a = byId.get(row.account_id);
      if (overWebsite && a !== undefined && lockStillRunning(row, checkedAt)) {
        stampOnly.run(checkedAt, row.account_id);
        continue;
      }
      const was = parseAccountBrokerStatus(row.broker_status);
      const wasCause = was === "ok" ? null : parseAccountStateCause(row.broker_state_cause);
      // Outside a session the answer could not say whether a stored lock
      // still holds, so its lock, cause and end stand; the facts still land.
      const held = a?.holdStoredLock === true && was === "locked";
      const state: AccountBrokerStatus = held ? "locked" : a?.state ?? "dead";
      // A breach once read stays named while the account stays dead: a later
      // answer without the balance compare only knows it as the website's.
      const keptBreach = was === "dead" && wasCause === "max-loss" && state === "dead" && a?.cause !== "max-loss";
      const kept = held || keptBreach;
      // An ok carries no cause whatever the answer said.
      const cause = state === "ok" ? null : kept ? wasCause : a?.cause ?? null;
      const reason = kept ? row.broker_lockout_reason : a?.lockoutReason ?? null;
      const until = held ? row.broker_lockout_until : a?.lockoutUntil ?? null;
      // A cause filled in under an unchanged state is no change: a row stored
      // before causes were, or a cause the last answer could not tell.
      const changed = was !== state || (wasCause !== null && wasCause !== cause);
      if (changed && !(was === null && state === "ok")) {
        transitions.push({
          accountId: row.account_id,
          from: { state: was, cause: wasCause },
          to: { state, cause, reason, until },
        });
      }
      const f = a?.facts ?? null;
      const keptOcoOff = overWebsite && row.broker_auto_oco === 0;
      update.run(
        state,
        checkedAt,
        a?.source ?? answer.source,
        a?.statusCode ?? null,
        reason,
        until,
        keptOcoOff ? 0 : f?.autoOcoBrackets == null ? null : f.autoOcoBrackets ? 1 : 0,
        f?.bracketAutoApply == null ? null : f.bracketAutoApply ? 1 : 0,
        f?.bracketAmountToRiskUsd ?? null,
        f?.bracketAmountToMakeUsd ?? null,
        f?.startingBalanceUsd ?? null,
        f?.maximumLossUsd ?? null,
        f?.highestBalanceUsd ?? null,
        f?.startOfDayBalanceUsd ?? null,
        f?.dailyLossUsd ?? null,
        f?.personalDailyLossLimitUsd ?? null,
        f?.personalDailyProfitTargetUsd ?? null,
        f?.stage ?? null,
        f?.templateId ?? null,
        cause,
        row.account_id,
      );
    }
    return transitions;
  });
  return tx();
}

/** The accounts a `recordAccountStates` write moved to `dead` from anything else. */
export function newlyDeadOf(transitions: readonly AccountStateTransition[]): number[] {
  return transitions.filter((t) => t.to.state === "dead" && t.from.state !== "dead").map((t) => t.accountId);
}

/** A stored lock with an end still ahead of `at`. Both are `toISOString()`. */
function lockStillRunning(
  row: Pick<AccountBrokerRow, "broker_status" | "broker_lockout_until">,
  at: string,
): boolean {
  return row.broker_status === "locked" && row.broker_lockout_until != null && row.broker_lockout_until > at;
}

/**
 * What the broker last reported about an account beyond its status, or `null`
 * when the last answer carried none — never checked, a search-sourced answer,
 * or Topstep's website read failing and the check falling back. The reader the
 * deploy gates and the Risk prefill are built on; `null`, for the whole or for
 * one field, is *unknown*.
 */
export function getBrokerAccountFacts(accountId: number): BrokerAccountFacts | null {
  const r = getDb()
    .prepare(`SELECT * FROM account_brokers WHERE account_id = ?`)
    .get(accountId) as AccountBrokerRow | undefined;
  return r ? brokerFactsOf(r) : null;
}

function brokerFactsOf(r: AccountBrokerRow): BrokerAccountFacts | null {
  if (r.broker_status_source !== "website") return null;
  return {
    autoOcoBrackets: r.broker_auto_oco == null ? null : r.broker_auto_oco === 1,
    bracketAutoApply: r.broker_bracket_auto_apply == null ? null : r.broker_bracket_auto_apply === 1,
    bracketAmountToRiskUsd: r.broker_bracket_risk_usd,
    bracketAmountToMakeUsd: r.broker_bracket_target_usd,
    startingBalanceUsd: r.broker_starting_balance_usd,
    maximumLossUsd: r.broker_max_loss_floor_usd,
    highestBalanceUsd: r.broker_highest_balance_usd,
    startOfDayBalanceUsd: r.broker_sod_balance_usd,
    dailyLossUsd: r.broker_daily_loss_limit_usd,
    personalDailyLossLimitUsd: r.broker_personal_dll_usd,
    personalDailyProfitTargetUsd: r.broker_personal_profit_target_usd,
    stage: r.broker_stage,
    templateId: r.broker_template_id,
  };
}

/**
 * What the account-state deploy gate reads, from one row. The facts follow
 * `getBrokerAccountFacts`' rule — read only off a website-sourced answer, null
 * otherwise — so a fallback reads as unknown. **One exception: a stored OCO
 * off reads off whatever the source**, because only a website answer ever
 * writes `0` and `recordAccountStates` keeps it through a fallback.
 */
function deployStateOf(r: AccountBrokerRow): AccountDeployState {
  const website = r.broker_status_source === "website";
  const flag = (v: number | null) => (!website || v == null ? null : v === 1);
  return {
    broker: r.broker === "tradovate" ? "tradovate" : "topstep",
    status: parseAccountBrokerStatus(r.broker_status),
    cause: parseAccountStateCause(r.broker_state_cause),
    lockoutReason: r.broker_lockout_reason,
    lockoutUntil: r.broker_lockout_until,
    autoOcoBrackets: r.broker_auto_oco === 0 ? false : flag(r.broker_auto_oco),
    bracketAutoApply: flag(r.broker_bracket_auto_apply),
    bracketRiskUsd: website ? r.broker_bracket_risk_usd : null,
    bracketTargetUsd: website ? r.broker_bracket_target_usd : null,
  };
}

/** The deploy gate's input for one account, or `null` when it has no row —
 *  which the live-account block has already refused. */
export function getAccountDeployState(accountId: number): AccountDeployState | null {
  const r = getDb()
    .prepare(`SELECT * FROM account_brokers WHERE account_id = ?`)
    .get(accountId) as AccountBrokerRow | undefined;
  return r ? deployStateOf(r) : null;
}

/** One catalogued account as the deploy surfaces read it: the gate's input,
 *  plus what the live-account block and the replacement match need. */
export interface AccountDeployRecord {
  accountId: number;
  name: string | null;
  state: AccountDeployState;
  /** Website facts; null unless the last answer was the website's. */
  templateId: number | null;
  startingBalanceUsd: number | null;
}

/** Every catalogued account, sorted by id, for `GET /api/books`' gate list. */
export function listAccountDeployRecords(): AccountDeployRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM account_brokers ORDER BY account_id`)
    .all() as AccountBrokerRow[];
  return rows.map((r) => {
    const website = r.broker_status_source === "website";
    return {
      accountId: r.account_id,
      name: r.account_name,
      state: deployStateOf(r),
      templateId: website ? r.broker_template_id : null,
      startingBalanceUsd: website ? r.broker_starting_balance_usd : null,
    };
  });
}

/**
 * The guard both status writers share, bound to the incoming answer's time.
 *
 * Refreshes are not serialized: one can take Topstep's list and then wait on
 * Tradovate while a status check records an account inactive, and finish
 * after it. Its answer is the older one, so the row keeps the newer — in
 * either direction. Stamps are `toISOString()`, which compares as text in
 * time order. An equal stamp is the same answer and is left alone.
 */
const STATUS_IS_OLDER = `(broker_status_checked_at IS NULL OR broker_status_checked_at < ?)`;

/**
 * Record that a broker just listed these accounts: each is `ok` as of
 * `checkedAt`. `BrokerRegistry.refresh()` calls it with **Tradovate's** ids,
 * whose search lists only accounts that can trade — so one false `dead` (a
 * broker that omitted a live account once) heals on the next refresh rather
 * than the next daily check.
 *
 * **Never with Topstep's**, and the statement refuses one (`broker =
 * 'tradovate'`) rather than trusting the caller. Its active-only search still
 * lists accounts its website shows as failed or ineligible, so a listed
 * Topstep id is no evidence the account can trade, and marking it here would
 * revive a dead account on every refresh. Topstep's status is the status
 * check's alone.
 *
 * **Only ever the `ok` half.** An id missing from a list is not marked
 * anything here: what went missing is `recordAccountStates`' to decide, from a
 * check that holds the whole of one broker's answer. Updates and never
 * inserts.
 *
 * `checkedAt` is when the arm's search returned, never when the refresh
 * finished, and a row stamped later is left alone ({@link STATUS_IS_OLDER}).
 */
export function markAccountsActive(accountIds: readonly number[], checkedAt: string): void {
  if (accountIds.length === 0) return;
  getDb()
    .prepare(
      `UPDATE account_brokers
          SET broker_status = 'ok', broker_status_checked_at = ?, broker_status_source = 'search'
        WHERE account_id IN (SELECT value FROM json_each(?)) AND broker = 'tradovate'
          AND ${STATUS_IS_OLDER}`,
    )
    .run(checkedAt, JSON.stringify(accountIds), checkedAt);
}

/** The status guard's rule on the balance's own stamp: the balance is stamped
 *  when the search answered, which is not the status's stamp on Topstep (that
 *  one is the website read's), so it is ordered on its own column. */
const BALANCE_IS_OLDER = `(broker_balance_at IS NULL OR broker_balance_at < ?)`;

/**
 * Record the balances one broker's account search reported, stamped `at` —
 * when that search returned. The account-status check is the only caller, and
 * only for a broker that answered, so a broker that did not answer writes
 * nothing and its accounts keep the last balance with its older stamp.
 *
 * **An older answer never overwrites a newer one** ({@link BALANCE_IS_OLDER}),
 * for the reason the status writers refuse one. A non-finite balance is not
 * written. An id this broker's catalogue does not hold is ignored; an account
 * the answer does not mention keeps what it had — a missing balance is not a
 * zero. Updates and never inserts.
 */
export function recordAccountBalances(
  broker: BrokerKind,
  balances: ReadonlyMap<number, number>,
  at: string,
): void {
  const db = getDb();
  const update = db.prepare(
    `UPDATE account_brokers SET broker_balance_usd = ?, broker_balance_at = ?
      WHERE account_id = ? AND broker = ? AND ${BALANCE_IS_OLDER}`,
  );
  db.transaction(() => {
    for (const [accountId, balance] of balances) {
      if (!Number.isFinite(balance)) continue;
      update.run(balance, at, accountId, broker, at);
    }
  })();
}

/** Whether any catalogued account is stored `locked` with no end time, or
 *  with an end at or before `at` — the post-open recheck's condition. Stamps
 *  are `toISOString()`, so the text compare is a time compare. */
export function hasLockedAccountToRecheck(at: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM account_brokers
          WHERE broker_status = 'locked'
            AND (broker_lockout_until IS NULL OR broker_lockout_until <= ?)) AS hit`,
    )
    .get(at) as { hit: number };
  return row.hit === 1;
}

/** One catalogued account's stored balance and status stamp, for the
 *  Dashboard's account cells. `balanceUsd` null is unknown. */
export interface AccountBalanceRecord {
  accountId: number;
  /** As stored; `unknown` for a value neither broker writes. */
  broker: "topstep" | "tradovate" | "unknown";
  balanceUsd: number | null;
  /** When the broker's search reported `balanceUsd`. */
  balanceAt: string | null;
  /** When the status was last answered — the stamp a refused account's stamp
   *  is as of. */
  checkedAt: string | null;
}

/** Every catalogued account's stored balance, sorted by id. */
export function listAccountBalances(): AccountBalanceRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT account_id, broker, broker_balance_usd, broker_balance_at, broker_status_checked_at
         FROM account_brokers ORDER BY account_id`,
    )
    .all() as Array<
    Pick<
      AccountBrokerRow,
      "account_id" | "broker" | "broker_balance_usd" | "broker_balance_at" | "broker_status_checked_at"
    >
  >;
  return rows.map((r) => ({
    accountId: r.account_id,
    broker: r.broker === "topstep" || r.broker === "tradovate" ? r.broker : "unknown",
    balanceUsd: r.broker_balance_usd,
    balanceAt: r.broker_balance_at,
    checkedAt: r.broker_status_checked_at,
  }));
}

/**
 * The account facts the auto-trade block classifies on, or `null` when
 * the app cannot prove them: no row at all, or a row seeded before
 * `account_name` / `practice` existed.
 *
 * `null` is not "permitted by default" — see `autoTradeVerdict`.
 */
export function getAccountTradingIdentity(accountId: number): AccountTradingIdentity | null {
  const row = getDb()
    .prepare(
      `SELECT broker, account_name, practice FROM account_brokers WHERE account_id = ?`,
    )
    .get(accountId) as Pick<AccountBrokerRow, "broker" | "account_name" | "practice"> | undefined;
  if (!row || row.account_name == null || row.practice == null) return null;
  return {
    name: row.account_name,
    broker: row.broker === "tradovate" ? "tradovate" : "topstep",
    practice: row.practice === 1,
  };
}

/**
 * The account's risk posture, or `null` when the operator has not set one.
 *
 * **Both columns or neither.** A budget with no ceiling sizes purely off how
 * tight today's stop happened to be, and a ceiling with no budget has nothing
 * to be a ceiling on — so a half-written row reads as unset rather than as a
 * posture with a default filled in. That is the same NULL-is-unknown reading
 * `getAccountTradingIdentity` applies one column over, and it fails the same
 * way: `resolveRiskSizedContracts` throws on `null`, the engine's per-leg
 * catch skips the tick, and no order goes out on a size nobody chose.
 *
 * A row that does not exist at all answers `null` too. There is no
 * default-to-Topstep equivalent here and there must not be one.
 */
export function getAccountRiskPosture(accountId: number): AccountRiskPosture | null {
  const row = getDb()
    .prepare(
      `SELECT max_risk_per_trade_usd, max_contracts FROM account_brokers WHERE account_id = ?`,
    )
    .get(accountId) as
    | Pick<AccountBrokerRow, "max_risk_per_trade_usd" | "max_contracts">
    | undefined;
  if (!row || row.max_risk_per_trade_usd == null || row.max_contracts == null) return null;
  return {
    maxRiskPerTradeUsd: row.max_risk_per_trade_usd,
    maxContracts: row.max_contracts,
  };
}

/**
 * Write the posture, or clear it with `null`.
 *
 * **It updates and never inserts.** The catalogue is the broker fan-out's to
 * populate, so a posture for an account the app has never seen would create a
 * row with no name and no `practice` — exactly the shape the live-account
 * block refuses, arriving through the settings form. `false` means no row was
 * touched, and the caller answers 404.
 */
export function setAccountRiskPosture(
  accountId: number,
  posture: AccountRiskPosture | null,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE account_brokers
         SET max_risk_per_trade_usd = ?, max_contracts = ?, updated_at = ?
       WHERE account_id = ?`,
    )
    .run(
      posture?.maxRiskPerTradeUsd ?? null,
      posture?.maxContracts ?? null,
      new Date().toISOString(),
      accountId,
    );
  return result.changes > 0;
}

/** What the operator declared the account is, and the one stamp the app
 *  writes about it. The `broker` tag is here because a phase is refused off
 *  Topstep — it is the only broker fact the phase path reads, and it is
 *  never the account *name*: the live-account block owns that predicate. */
export interface AccountRiskPhaseSettings {
  broker: "topstep" | "tradovate";
  phase: AccountRiskPhase;
  mllUsd: number | null;
  startBalanceUsd: number | null;
  /** `combine_press`'s headroom threshold; null in every other phase. */
  pressAtUsd: number | null;
  /** Set the first time the account is saved as `funded_paid`, never cleared. */
  payoutTakenAt: string | null;
}

/** The four fields the settings form owns. The stamp is the app's. */
export interface AccountRiskPhaseInput {
  phase: AccountRiskPhase;
  mllUsd: number | null;
  startBalanceUsd: number | null;
  pressAtUsd: number | null;
}

/**
 * The account's declared phase, or `null` when the catalogue has no row.
 *
 * An unrecognised stored value reads as `off` (`parseAccountRiskPhase`), so a
 * row written before the column existed and a row written by a future version
 * both fall through to the flat posture rather than to a bucket.
 */
export function getAccountRiskPhase(accountId: number): AccountRiskPhaseSettings | null {
  const row = getDb()
    .prepare(
      `SELECT broker, risk_phase, mll_usd, start_balance_usd, press_at_usd, payout_taken_at
         FROM account_brokers WHERE account_id = ?`,
    )
    .get(accountId) as
    | Pick<
        AccountBrokerRow,
        | "broker"
        | "risk_phase"
        | "mll_usd"
        | "start_balance_usd"
        | "press_at_usd"
        | "payout_taken_at"
      >
    | undefined;
  if (!row) return null;
  return {
    broker: row.broker === "tradovate" ? "tradovate" : "topstep",
    phase: parseAccountRiskPhase(row.risk_phase),
    mllUsd: row.mll_usd,
    startBalanceUsd: row.start_balance_usd,
    pressAtUsd: row.press_at_usd,
    payoutTakenAt: row.payout_taken_at,
  };
}

/**
 * Write the declared phase, or clear it with `null`.
 *
 * **It updates and never inserts**, for the reason `setAccountRiskPosture`
 * does. Three properties beyond that:
 *
 * `off` is stored as NULL rather than as the string, because NULL is the
 * column's inert reading and a row that has never been touched must be
 * indistinguishable from one the operator switched back off.
 *
 * **`payout_taken_at` is stamped on the first `funded_paid` save and never
 * cleared** — not by a later phase change, not by clearing the posture, not
 * by the seed. It is what makes the combine posture impossible on an account
 * that has taken a payout: the route refuses `combine` and `funded_fresh`
 * once it is set, and a funded account id is never a combine again.
 *
 * Clearing (`null`) nulls the phase, the MLL, the starting balance and the
 * press threshold and **nothing else** — the stamp and the sample columns
 * survive it.
 */
export function setAccountRiskPhase(
  accountId: number,
  settings: AccountRiskPhaseInput | null,
): boolean {
  const now = new Date().toISOString();
  const phase = settings?.phase ?? "off";
  const result = getDb()
    .prepare(
      `UPDATE account_brokers
         SET risk_phase = ?, mll_usd = ?, start_balance_usd = ?, press_at_usd = ?,
             payout_taken_at = COALESCE(payout_taken_at, ?), updated_at = ?
       WHERE account_id = ?`,
    )
    .run(
      phase === "off" ? null : phase,
      settings?.mllUsd ?? null,
      settings?.startBalanceUsd ?? null,
      settings?.pressAtUsd ?? null,
      phase === "funded_paid" ? now : null,
      now,
      accountId,
    );
  return result.changes > 0;
}

/**
 * Record one end-of-day close for the session it sizes.
 *
 * The balance comes from the broker's own `searchAccounts` fan-out, not from
 * the operator: typing a close by hand is the one input that can size an
 * account **up** on a typo, and stopping that is why this exists.
 *
 * Two refusals, both silent and both fail-closed — the account keeps the
 * lowest budget of its phase rather than getting a wrong one:
 *
 * **A sample taken after the session it would size has already opened writes
 * nothing.** `sessionStart` is that session's open instant, so a fill inside
 * it could already be in the balance, and a budget set from a live balance is
 * the intraday posture nobody measured.
 *
 * **A non-finite balance writes nothing.** The catalogue's `balance` is safe
 * to default to 0 everywhere else; that default is withdrawn here, because a
 * zero close reads as a busted account.
 *
 * The peak is monotone in SQL (`MAX(COALESCE(peak, close), close)`) so two
 * writers cannot race it downward, and the first sample on an account sets
 * the peak to that close.
 */
export function recordSessionClose(
  accountId: number,
  sample: { balance: number; sessionStart: string; now: Date },
): boolean {
  if (!Number.isFinite(sample.balance)) return false;
  if (sample.now.getTime() >= Date.parse(sample.sessionStart)) return false;
  const result = getDb()
    .prepare(
      `UPDATE account_brokers
         SET eod_balance_usd = ?,
             eod_peak_usd = MAX(COALESCE(eod_peak_usd, ?), ?),
             eod_sizes_session_start = ?, eod_recorded_at = ?, updated_at = ?
       WHERE account_id = ?`,
    )
    .run(
      sample.balance,
      sample.balance,
      sample.balance,
      sample.sessionStart,
      sample.now.toISOString(),
      sample.now.toISOString(),
      accountId,
    );
  return result.changes > 0;
}

/**
 * The posture for the session `now` falls in — the phase-aware budget, or the
 * flat one when the account is `off`.
 *
 * One indexed lookup per call, as the daily gate does: the operator may change
 * the phase mid-session and the read is cheap. **It does not log** — a stale
 * sample is a state, not an event, and warning about it once per account per
 * session is the engine's job rather than a per-tick read's.
 */
export function resolveSessionPosture(accountId: number, now: Date = new Date()): SessionBudget {
  const row = getDb()
    .prepare(
      `SELECT broker, risk_phase, mll_usd, start_balance_usd, press_at_usd,
              eod_balance_usd, eod_peak_usd, eod_sizes_session_start,
              max_risk_per_trade_usd, max_contracts
         FROM account_brokers WHERE account_id = ?`,
    )
    .get(accountId) as SessionBudgetColumns | undefined;
  return resolveSessionBudget(row ? toSessionBudgetRow(row) : null, now);
}

type SessionBudgetColumns = Pick<
  AccountBrokerRow,
  | "broker"
  | "risk_phase"
  | "mll_usd"
  | "start_balance_usd"
  | "press_at_usd"
  | "eod_balance_usd"
  | "eod_peak_usd"
  | "eod_sizes_session_start"
  | "max_risk_per_trade_usd"
  | "max_contracts"
>;

function toSessionBudgetRow(row: SessionBudgetColumns): SessionBudgetRow {
  return {
    broker: row.broker === "tradovate" ? "tradovate" : "topstep",
    riskPhase: parseAccountRiskPhase(row.risk_phase),
    mllUsd: row.mll_usd,
    startBalanceUsd: row.start_balance_usd,
    pressAtUsd: row.press_at_usd,
    eodBalanceUsd: row.eod_balance_usd,
    eodPeakUsd: row.eod_peak_usd,
    eodSizesSessionStart: row.eod_sizes_session_start,
    maxRiskPerTradeUsd: row.max_risk_per_trade_usd,
    maxContracts: row.max_contracts,
  };
}

/**
 * The account's daily P&L gate, re-scoped here from the deployment.
 *
 * **Unset reads as "off", not as a refusal — the opposite of the posture one
 * function up, and deliberately.** A missing budget means the app cannot say
 * what an entry may risk, so it refuses; a missing daily limit means the
 * operator has not asked for one, which is exactly what `0` meant on the
 * retired `CommonParams` keys. Blocking every entry on an account whose daily
 * gate was never configured would stop it trading on a setting nobody touched.
 * The three fields are independent: a loss limit with no profit limit is an
 * ordinary configuration, so this is not the both-or-neither read.
 */
export function getAccountDailyPnlLimits(accountId: number): DailyPnlLimits {
  const row = getDb()
    .prepare(
      `SELECT daily_max_loss_usd, daily_max_profit_usd, daily_pnl_include_unrealized
         FROM account_brokers WHERE account_id = ?`,
    )
    .get(accountId) as
    | Pick<
        AccountBrokerRow,
        "daily_max_loss_usd" | "daily_max_profit_usd" | "daily_pnl_include_unrealized"
      >
    | undefined;
  return dailyLimitsOf(row);
}

function dailyLimitsOf(
  row:
    | Pick<
        AccountBrokerRow,
        "daily_max_loss_usd" | "daily_max_profit_usd" | "daily_pnl_include_unrealized"
      >
    | undefined,
): DailyPnlLimits {
  return {
    dailyMaxLossUsd: row?.daily_max_loss_usd ?? 0,
    dailyMaxProfitUsd: row?.daily_max_profit_usd ?? 0,
    dailyPnlIncludeUnrealized: row?.daily_pnl_include_unrealized === 1,
  };
}

/**
 * Write the daily gate, or clear it with `null`.
 *
 * **It updates and never inserts**, for the reason `setAccountRiskPosture`
 * does: the catalogue is the broker fan-out's to populate.
 */
export function setAccountDailyPnlLimits(
  accountId: number,
  limits: DailyPnlLimits | null,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE account_brokers
         SET daily_max_loss_usd = ?, daily_max_profit_usd = ?,
             daily_pnl_include_unrealized = ?, updated_at = ?
       WHERE account_id = ?`,
    )
    .run(
      limits == null || limits.dailyMaxLossUsd <= 0 ? null : limits.dailyMaxLossUsd,
      limits == null || limits.dailyMaxProfitUsd <= 0 ? null : limits.dailyMaxProfitUsd,
      limits?.dailyPnlIncludeUnrealized ? 1 : null,
      new Date().toISOString(),
      accountId,
    );
  return result.changes > 0;
}

/** What `carryRiskSettings` copied. `phase` is null when none was carried. */
export interface CarriedRiskSettings {
  posture: boolean;
  dailyPnl: boolean;
  phase: AccountRiskPhase | null;
}

/**
 * *Move to replacement*'s copy of the operator's own settings onto the new
 * account, each **only where the new account has none**: the posture (as the
 * pair it reads as), the daily limits (as a set), and the phase with its press
 * threshold. Without it every moved `Active` leg's entry throws in the sizer.
 *
 * **Never the maximum loss limit or the starting balance** — a reset changes
 * both, so they come from the Risk prefill off the new account's own record. A
 * combine phase carried without them throws in the resolver until they are
 * saved, which is the fail-closed direction. Through the setters, so a carried
 * `funded_paid` stamps the payout as a typed one does. Run inside the move's
 * transaction.
 */
export function carryRiskSettings(fromId: number, toId: number): CarriedRiskSettings {
  const carried: CarriedRiskSettings = { posture: false, dailyPnl: false, phase: null };
  const posture = getAccountRiskPosture(fromId);
  if (posture != null && getAccountRiskPosture(toId) == null) {
    carried.posture = setAccountRiskPosture(toId, posture);
  }
  const daily = getAccountDailyPnlLimits(fromId);
  const target = getAccountDailyPnlLimits(toId);
  const hasLimit = (l: DailyPnlLimits) => l.dailyMaxLossUsd > 0 || l.dailyMaxProfitUsd > 0;
  if (hasLimit(daily) && !hasLimit(target)) carried.dailyPnl = setAccountDailyPnlLimits(toId, daily);
  const from = getAccountRiskPhase(fromId);
  const to = getAccountRiskPhase(toId);
  if (from != null && from.phase !== "off" && to != null && to.phase === "off") {
    const written = setAccountRiskPhase(toId, {
      phase: from.phase,
      mllUsd: to.mllUsd,
      startBalanceUsd: to.startBalanceUsd,
      pressAtUsd: from.pressAtUsd,
    });
    if (written) carried.phase = from.phase;
  }
  return carried;
}

export function getAccountRiskSettings(accountId: number): AccountRiskSettings {
  return {
    posture: getAccountRiskPosture(accountId),
    dailyPnl: getAccountDailyPnlLimits(accountId),
    phase: getAccountRiskPhase(accountId),
  };
}

/**
 * Log what a write changed on an account's risk row, against the settings read
 * before it. **The engine reads these per tick, so the moment one changes is
 * the moment its behaviour changes**, and nothing else records that moment:
 * `updated_at` is overwritten by every status check. The parity check reads the
 * line to tell a gate that misfired from a limit that was not yet set. A write
 * that changed nothing logs nothing. Call only after the write has committed,
 * so a rolled-back write is not reported as a change.
 */
export function logAccountRiskChange(
  accountId: number,
  before: AccountRiskSettings,
  cause: string,
): void {
  const changes = describeAccountRiskChange(before, getAccountRiskSettings(accountId));
  if (changes.length === 0) return;
  log.event(ACCOUNT_RISK_SETTINGS_CHANGED, "db", accountRiskChangeMessage(accountId, cause, changes), { accountId });
}

/** The last close the app recorded for an account, as the Settings block
 *  renders it: the operator never types these, and a phase with no sample on
 *  record runs the lowest budget of that phase. */
export interface AccountEodSample {
  balanceUsd: number | null;
  peakUsd: number | null;
  sizesSessionStart: string | null;
  recordedAt: string | null;
}

/** Every account the catalogue carries, with its posture, its daily gate, its
 *  declared phase and the last close recorded for it — what the Settings block
 *  renders. Sorted by id so the list does not reorder between reads. */
export function listAccountRiskPostures(): Array<{
  accountId: number;
  name: string | null;
  broker: BrokerKind;
  practice: boolean | null;
  posture: AccountRiskPosture | null;
  dailyPnl: DailyPnlLimits;
  riskPhase: AccountRiskPhaseSettings;
  eodSample: AccountEodSample;
  /** Every row is returned whatever its status; which ones the Risk page lists
   *  is the page's decision (`listedOnRisk`), because the close sampler reads
   *  this same list and a hidden practice account still needs its close. */
  status: AccountStatusRecord;
  /** What the broker's website last reported — the Risk page's prefill
   *  suggestions read it. Null unless the last answer was the website's. */
  brokerFacts: BrokerAccountFacts | null;
}> {
  const rows = getDb()
    .prepare(`SELECT * FROM account_brokers ORDER BY account_id`)
    .all() as AccountBrokerRow[];
  return rows.map((r) => ({
    accountId: r.account_id,
    name: r.account_name,
    broker: r.broker === "tradovate" ? BrokerKind.Tradovate : BrokerKind.Topstep,
    practice: r.practice == null ? null : r.practice === 1,
    posture:
      r.max_risk_per_trade_usd == null || r.max_contracts == null
        ? null
        : {
            maxRiskPerTradeUsd: r.max_risk_per_trade_usd,
            maxContracts: r.max_contracts,
          },
    dailyPnl: dailyLimitsOf(r),
    riskPhase: {
      broker: r.broker === "tradovate" ? "tradovate" : "topstep",
      phase: parseAccountRiskPhase(r.risk_phase),
      mllUsd: r.mll_usd,
      startBalanceUsd: r.start_balance_usd,
      pressAtUsd: r.press_at_usd,
      payoutTakenAt: r.payout_taken_at,
    },
    eodSample: {
      balanceUsd: r.eod_balance_usd,
      peakUsd: r.eod_peak_usd,
      sizesSessionStart: r.eod_sizes_session_start,
      recordedAt: r.eod_recorded_at,
    },
    status: statusRecordOf(r),
    brokerFacts: brokerFactsOf(r),
  }));
}

/**
 * Persisted-state adapter for the one auto-trade rule. Every server-side
 * gate — the deployment routes, `listManagedDeployments()`, the engine
 * route's body-supplied list — calls this rather than reading the row and
 * re-deriving the comparison.
 *
 * The catalog is seeded from each broker's `searchAccounts()` at boot
 * (`runBootSequence`) and refreshed by `BrokerRegistry.refresh()`, so this
 * needs no network call on the deploy path.
 */
export function autoTradeVerdictForAccountId(accountId: number): AutoTradeVerdict {
  return autoTradeVerdict(getAccountTradingIdentity(accountId));
}

/**
 * The same verdict for many accounts, in one query.
 *
 * `listManagedDeployments()` screens every enabled row on every engine
 * sync, and better-sqlite3 does not cache `prepare()`, so the per-row
 * variant is one prepare plus one get per deployment. Ids repeat across
 * legs of a group, and the map is keyed by id, so a 10-leg group on one
 * account costs one row either way.
 */
export function autoTradeVerdictsForAccountIds(
  accountIds: Iterable<number>,
): Map<number, AutoTradeVerdict> {
  const ids = Array.from(new Set(accountIds));
  const verdicts = new Map<number, AutoTradeVerdict>();
  if (ids.length === 0) return verdicts;

  const rows = getDb()
    .prepare(
      `SELECT account_id, broker, account_name, practice FROM account_brokers
       WHERE account_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<
    Pick<AccountBrokerRow, "account_id" | "broker" | "account_name" | "practice">
  >;

  const identities = new Map<number, AccountTradingIdentity>();
  for (const row of rows) {
    // Same NULL-is-unknown reading as `getAccountTradingIdentity`: a row
    // with no name never becomes an identity, so it falls through to the
    // `null` arm below and is refused.
    if (row.account_name == null || row.practice == null) continue;
    identities.set(row.account_id, {
      name: row.account_name,
      broker: row.broker === "tradovate" ? "tradovate" : "topstep",
      practice: row.practice === 1,
    });
  }

  for (const id of ids) {
    verdicts.set(id, autoTradeVerdict(identities.get(id) ?? null));
  }
  return verdicts;
}

/**
 * `autoTradeVerdictsForAccountIds` for a surface that reports the verdict
 * rather than gating on it, failing closed: an id the read does not answer,
 * or every id when the read throws, is refused as unverified, the way the
 * gates would refuse it. The fallback lives here once because a surface that
 * copies the call without the catch fails open on a thrown read. `tag` is
 * the caller's log tag, so the failure line names the route that hit it.
 */
export function autoTradeVerdictsOrUnverified(
  accountIds: Iterable<number>,
  tag: string,
): (accountId: number) => AutoTradeVerdict {
  let verdicts = new Map<number, AutoTradeVerdict>();
  try {
    verdicts = autoTradeVerdictsForAccountIds(accountIds);
  } catch (err) {
    log.event(
      "db_error",
      tag,
      `auto-trade verdict read failed (every account reads unverified): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (accountId) => verdicts.get(accountId) ?? autoTradeVerdict(null);
}

export interface AutoTradeRefusal {
  /** Operator-facing summary. The lone refusal's reason when there is one. */
  message: string;
  refused: Array<{ accountId: number; reason: string }>;
}

/**
 * Screen a set of candidate accounts. Returns `null` when every one of
 * them may be auto-traded, and a refusal otherwise.
 *
 * Every route that creates, re-points or re-enables a deployment calls
 * this — including the single-account ones, so all of them reject in the
 * same shape and none of them grows its own message.
 *
 * **Two predicates, asked in order, each once per account**: the
 * live-account block (`autoTradeVerdict`), then — only for an account it
 * permits — the account-state gate (`accountStateVerdict`: dead, locked,
 * Topstep OCO off or unknown). Each answers its own question; neither is a
 * second copy of the other. The state gate lives here and not in
 * `autoTradeVerdict` because that predicate also filters the engine's
 * managed set, and a lockout must never drop a live position out of it
 * (`account-state-gate.ts`).
 *
 * **An empty set returns `null`, and the caller owns that case.** There is
 * nothing to refuse in a zero-length list, and every route that reaches
 * here with a fixed account already validated it upstream. A caller
 * deriving the list from rows that can be empty — a group's legs, say —
 * must reject the empty case itself before calling, or a 0→1 enable on a
 * legless group passes this screen silently. Do not "fix" that by making
 * empty a refusal here; it would make every validating caller's error
 * message wrong.
 */
export function screenAccountsForAutoTrade(accountIds: readonly number[]): AutoTradeRefusal | null {
  const refused: Array<{ accountId: number; reason: string }> = [];
  const now = new Date();
  for (const accountId of accountIds) {
    const verdict = autoTradeVerdictForAccountId(accountId);
    if (!verdict.permitted) {
      refused.push({ accountId, reason: verdict.reason });
      continue;
    }
    // A permitted account has a row — the block refuses one without.
    const state = getAccountDeployState(accountId);
    const stateVerdict = state ? accountStateVerdict(state, now) : null;
    if (stateVerdict && !stateVerdict.permitted) {
      refused.push({ accountId, reason: stateVerdict.reason });
    }
  }
  if (refused.length === 0) return null;
  // Every distinct reason, not just the first: a live account and an
  // unclassified one refuse for different reasons and only one of them is
  // recoverable, so showing `refused[0]` alone can tell the operator to
  // give up on an account that a dashboard reload would fix. "selected"
  // is out for the same honesty reason — this also fires from a group
  // toggle, where the operator selected nothing.
  const reasons = Array.from(new Set(refused.map((r) => r.reason)));
  const message =
    refused.length === 1
      ? refused[0].reason
      : `${refused.length} of ${accountIds.length} accounts cannot be auto-traded. ${reasons.join(" ")}`;
  return { message, refused };
}

/**
 * Every account id in the catalog, whatever broker tagged it.
 *
 * This is the set the log scrubber truncates in rendered text, and it is
 * read through this module rather than by a query of its own so the
 * "one owner per table" rule holds for the privacy path too.
 */
export function listAllAccountIds(): number[] {
  const rows = getDb().prepare(`SELECT account_id FROM account_brokers`).all() as Array<{
    account_id: number;
  }>;
  return rows.map((r) => r.account_id);
}

/**
 * Wire the catalog into the log scrubber at import time.
 *
 * The direction is load-bearing: `db/connection.ts` imports the logger, so
 * a static import from `logging/` into `db/` would close a cycle through
 * the one file every table module depends on. `logging/scrub.ts` therefore
 * imports nothing and takes its source from here. See
 * [docs/modules/logging/README.md].
 */
setManagedAccountSource(listAllAccountIds);

/** Returns every account-id currently tagged with the given broker. */
export function listAccountIdsForBroker(broker: BrokerKind): number[] {
  const rows = getDb()
    .prepare(`SELECT account_id FROM account_brokers WHERE broker = ?`)
    .all(broker) as Array<{ account_id: number }>;
  return rows.map((r) => r.account_id);
}
