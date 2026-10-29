/**
 * Topstep's website account record — `GET userapi.topstepx.com/TradingAccount`.
 *
 * **Undocumented.** It is the backend the Topstep website itself calls, found
 * by guessing the host on 2026-10-14, and it may change or disappear without
 * notice. It is read because the documented API cannot tell a tradable account
 * from a dead one: `/api/Account/search` with `onlyActiveAccounts: true` still
 * lists accounts the website shows as failed or ineligible. See
 * docs/modules/brokers/topstep.md, "Undocumented website API".
 *
 * Three rules shape this file:
 *
 * - **GET only, ever.** Nothing in the app writes to this host — no POST, PUT
 *   or PATCH, nothing that changes an account's settings. The operator changes
 *   Topstep settings on the website. A source scan in the test pins it.
 * - **No session of its own.** It sends the token already in the shared cache
 *   (`auth_token`, the one `getToken()` serves on its hot path) and never
 *   mints: no cached token, an expired one, or a 401 is a failed read, not a
 *   reason to call `loginKey` — a mint sends `gatewaylogout` to the engine's
 *   own hubs.
 * - **Optional.** It never throws. A failed call or a body that does not match
 *   the fields below answers `{ ok: false }`, and the status check falls back
 *   to the documented search.
 */
import { getCachedToken, type CachedToken } from "./token-cache";
import type { AccountStateAnswer, BrokerStatusAnswer } from "@/lib/db/account-brokers";

export const TOPSTEP_USERAPI_URL = "https://userapi.topstepx.com";
const TRADING_ACCOUNT_PATH = "/TradingAccount";
const READ_TIMEOUT_MS = 15_000;

/** The fields of one record the app relies on — and only those; the record
 *  carries about seventy. Observed meanings are in topstep.md. Every field
 *  past the lock is a fact, and null on a fact is *unknown*. */
export interface TopstepTradingAccount {
  accountId: number;
  accountName: string | null;
  /** The website's *Ineligible* / violation flag. True means dead. */
  ineligible: boolean;
  /** 0 OK, 2 violation, 6 ineligible; other codes not yet seen. */
  status: number;
  lockoutReason: string | null;
  lockoutExpiration: string | null;
  /** The website's OCO setting (confirmed by the operator against the site). */
  autoOcoBrackets: boolean | null;
  bracketAutoApply: boolean | null;
  bracketAmountToRisk: number | null;
  bracketAmountToMake: number | null;
  startingBalance: number | null;
  /** The current maximum-loss floor, in dollars of balance. */
  maximumLoss: number | null;
  /** The highest balance the floor trails from; with `maximumLoss` it gives
   *  the loss limit's size (the Risk prefill). */
  highestBalance: number | null;
  startOfDayBalance: number | null;
  dailyLoss: number | null;
  personalDailyLossLimit: number | null;
  personalDailyProfitTarget: number | null;
  stage: number | null;
  templateId: number | null;
}

/** Why a read failed, coarse enough to count in prod. */
export type TopstepReadFailureKind = "no-token" | "expired" | "unauthorized" | "http" | "network" | "shape";

export type TopstepTradingAccountsAnswer =
  | { ok: true; accounts: TopstepTradingAccount[]; at: string }
  | { ok: false; kind: TopstepReadFailureKind; reason: string };

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The fields the status is read from. Each must be present — a nullable one
 *  as `null`, not absent — so a renamed field fails the record rather than
 *  reading as "not locked" or "eligible". */
const STATUS_CHECKS: ReadonlyArray<[keyof TopstepTradingAccount, (v: unknown) => boolean]> = [
  ["accountId", (v) => Number.isSafeInteger(v)],
  ["ineligible", (v) => typeof v === "boolean"],
  ["status", (v) => Number.isSafeInteger(v)],
  ["lockoutReason", (v) => v === null || typeof v === "string"],
  ["lockoutExpiration", (v) => v === null || typeof v === "string"],
];

/**
 * One record, or null when its status fields fail the guard.
 *
 * **A fact field never fails the record.** Absent, null or mistyped, it reads
 * as null — unknown — because a program the 2026-10-14 probe never saw (XFA,
 * a combine with no daily loss limit) may carry a null limit, and failing the
 * record would fail the whole answer and put every Topstep account on the
 * search's coarser reading. Unknown is the safe direction for every reader:
 * a deploy gate refuses on an unknown OCO, and the prefill leaves a field blank.
 */
export function parseTopstepTradingAccount(value: unknown): TopstepTradingAccount | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!STATUS_CHECKS.every(([key, check]) => own(rec, key) && check(rec[key]))) return null;
  const fact = (key: keyof TopstepTradingAccount): unknown => (own(rec, key) ? rec[key] : null);
  const bool = (key: keyof TopstepTradingAccount) => {
    const v = fact(key);
    return typeof v === "boolean" ? v : null;
  };
  const num = (key: keyof TopstepTradingAccount) => {
    const v = fact(key);
    return isNumber(v) ? v : null;
  };
  const int = (key: keyof TopstepTradingAccount) => {
    const v = num(key);
    return v !== null && Number.isSafeInteger(v) ? v : null;
  };
  const name = fact("accountName");
  return {
    accountId: rec.accountId as number,
    accountName: typeof name === "string" ? name : null,
    ineligible: rec.ineligible as boolean,
    status: rec.status as number,
    lockoutReason: rec.lockoutReason as string | null,
    lockoutExpiration: rec.lockoutExpiration as string | null,
    autoOcoBrackets: bool("autoOcoBrackets"),
    bracketAutoApply: bool("bracketAutoApply"),
    bracketAmountToRisk: num("bracketAmountToRisk"),
    bracketAmountToMake: num("bracketAmountToMake"),
    startingBalance: num("startingBalance"),
    maximumLoss: num("maximumLoss"),
    highestBalance: num("highestBalance"),
    startOfDayBalance: num("startOfDayBalance"),
    dailyLoss: num("dailyLoss"),
    personalDailyLossLimit: num("personalDailyLossLimit"),
    personalDailyProfitTarget: num("personalDailyProfitTarget"),
    stage: int("stage"),
    templateId: int("templateId"),
  };
}

export interface TopstepTradingAccountDeps {
  cachedToken: () => CachedToken | null;
  fetch: typeof fetch;
  now: () => Date;
}

const DEFAULT_DEPS: TopstepTradingAccountDeps = {
  cachedToken: getCachedToken,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
};

/**
 * Read every account record Topstep's website holds for this login.
 *
 * **One record whose status fields fail the guard fails the whole answer.**
 * The status check gives an account a successful answer omits the search's
 * reading, so dropping that record would put an account the website may call
 * dead or locked on the search's coarser answer while the rest read finely —
 * a fallback for all of them is the honest shape, and it is said.
 */
export async function readTopstepTradingAccounts(
  deps: TopstepTradingAccountDeps = DEFAULT_DEPS,
): Promise<TopstepTradingAccountsAnswer> {
  let cached: CachedToken | null;
  try {
    cached = deps.cachedToken();
  } catch (err) {
    return { ok: false, kind: "no-token", reason: `token cache unreadable (${errorText(err)})` };
  }
  if (cached === null) return { ok: false, kind: "no-token", reason: "no Topstep session token is cached" };
  if (cached.expiresAt * 1000 <= deps.now().getTime()) {
    return { ok: false, kind: "expired", reason: "the cached Topstep session token has expired" };
  }
  let res: Response;
  try {
    res = await deps.fetch(`${TOPSTEP_USERAPI_URL}${TRADING_ACCOUNT_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cached.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: "network", reason: errorText(err) };
  }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? "unauthorized" : "http";
    return { ok: false, kind, reason: `HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, kind: "shape", reason: `the answer is not JSON (${errorText(err)})` };
  }
  const at = deps.now().toISOString();
  if (!Array.isArray(body)) return { ok: false, kind: "shape", reason: "the answer is not a list of accounts" };
  const accounts: TopstepTradingAccount[] = [];
  for (const [i, raw] of body.entries()) {
    const parsed = parseTopstepTradingAccount(raw);
    if (parsed === null) {
      return { ok: false, kind: "shape", reason: `account record ${i + 1} of ${body.length} has an unexpected shape` };
    }
    accounts.push(parsed);
  }
  return { ok: true, accounts, at };
}

/**
 * One record as a status.
 *
 * `ineligible` is dead, whatever else the record says. Otherwise a lockout —
 * a reason or an expiry — is `locked` until its expiry passes; a lockout with
 * no readable expiry stays `locked`, because nothing says when it ends. The
 * expiry is compared with the time the answer arrived; the Risk page compares
 * it again at render.
 */
export function topstepAccountState(acct: TopstepTradingAccount, at: string): AccountStateAnswer {
  const until = parseInstant(acct.lockoutExpiration);
  const lockedOut =
    (acct.lockoutReason !== null || acct.lockoutExpiration !== null) &&
    (until === null || until.getTime() > Date.parse(at));
  const state = acct.ineligible ? "dead" : lockedOut ? "locked" : "ok";
  return {
    accountId: acct.accountId,
    source: "website",
    state,
    cause: state === "ok" ? null : "website",
    statusCode: acct.status,
    lockoutReason: acct.lockoutReason,
    lockoutUntil: until?.toISOString() ?? null,
    facts: {
      autoOcoBrackets: acct.autoOcoBrackets,
      bracketAutoApply: acct.bracketAutoApply,
      bracketAmountToRiskUsd: acct.bracketAmountToRisk,
      bracketAmountToMakeUsd: acct.bracketAmountToMake,
      startingBalanceUsd: acct.startingBalance,
      maximumLossUsd: acct.maximumLoss,
      highestBalanceUsd: acct.highestBalance,
      startOfDayBalanceUsd: acct.startOfDayBalance,
      dailyLossUsd: acct.dailyLoss,
      personalDailyLossLimitUsd: acct.personalDailyLossLimit,
      personalDailyProfitTargetUsd: acct.personalDailyProfitTarget,
      stage: acct.stage,
      templateId: acct.templateId,
    },
  };
}

/** A successful read as the status check's per-broker answer. */
export function topstepStatusAnswer(accounts: readonly TopstepTradingAccount[], at: string): BrokerStatusAnswer {
  return { source: "website", accounts: accounts.map((a) => topstepAccountState(a, at)) };
}

/** An instant only when the string names its zone: without `Z` or an offset,
 *  `new Date` reads it in the server's local time, which is a guess. */
const ZONED_INSTANT = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseInstant(raw: string | null): Date | null {
  if (raw === null || !ZONED_INSTANT.test(raw.trim())) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
