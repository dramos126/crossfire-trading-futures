import { log } from "@/lib/logger";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { TradovateClient } from "@/lib/brokers/tradovate/client";
import {
  BrokerKind,
  getAccountBrokerOrTopstep,
  listAccountIdsForBroker,
  markAccountsActive,
  setAccountBrokers,
  toAccountBrokerSeeds,
} from "@/lib/db/account-brokers";
import { getTradovateApiCid } from "@/lib/db/settings";
import { listManagedDeployments } from "@/lib/db/deployments";
import { sendDiscordAlert, type AlertDelivery } from "@/lib/notify/discord";
import type { Broker } from "./broker";
import type { Account } from "@/lib/brokers/types";

/**
 * Per-account broker routing registry. The runtime source of truth for
 * "which `Broker` does this accountId belong to".
 *
 * Built by fanning `searchAccounts()` out across every configured broker
 * client, merging the results, and tagging each account with the broker
 * that returned it. Refreshed at the same 30-min cadence as the engine's
 * account-name cache.
 *
 * Carries a partial-failure model:
 *   - A broker's search fails → that broker's previous entries are carried
 *     forward unchanged, so an outage never re-routes and never un-registers
 *     an account it failed to ask about. On a cold boot there is nothing to
 *     carry, so those ids are simply absent — and the orphan cross-checks
 *     skip them rather than pause them, via `attributeAbsentAccount` (A74).
 *   - Tradovate is expected but has no client (a failed first login, or
 *     creds removed under a Tradovate deployment) → a failed arm in
 *     `errors.tradovate`, never an unconfigured one; nothing carried forward.
 *   - Whether Tradovate is expected could not be read (a DB error) → also a
 *     failed arm, because a skipped arm must never pass for an answer; the
 *     alert stays silent. See `tradovateExpectation()`.
 *   - Tradovate search fails AND Tradovate is *expected* (creds present
 *     OR a Tradovate-broker deployment exists) → loud Discord alert.
 *   - Tradovate search fails AND Tradovate is *not* expected → silent;
 *     no warn log, no alert (default state for installs without
 *     Tradovate creds).
 *
 * The registry never throws on `get()` — callers that need the broker
 * for an unknown id throw their own engine-error so the failure is
 * scoped to the deployment that hit it (engine's `brokerForAccount`).
 */

const TRADOVATE_CLIENT_UNAVAILABLE =
  "Tradovate is expected but has no authenticated client";

export interface BrokerRegistryClients {
  /** Null on a Tradovate-only install. The fan-out below skips the arm
   *  entirely, exactly as it already does for an absent Tradovate — an
   *  unconfigured broker is not a failed broker, so `errors.topstep`
   *  stays null and the refresh is not "partial". */
  topstep: TopstepClient | null;
  tradovate: TradovateClient | null;
}

/** An account that was already mapped and is now routed to a different
 *  broker. Never emitted for an account seen for the first time. */
export interface BrokerKindChange {
  accountId: number;
  from: BrokerKind;
  to: BrokerKind;
  name: string | null;
}

export interface RefreshResult {
  /** True when at least one configured broker's fan-out threw, or an
   *  expected broker had no client to fan out through. */
  partial: boolean;
  /** Per-broker error (null = success). Used by engine boot to decide
   *  whether to surface partial-failure to the operator. */
  errors: { topstep: string | null; tradovate: string | null };
  /** The account ids each arm answered with, fixed when this refresh returns;
   *  null for an arm that did not answer — failed **or** never run, which
   *  `errors` alone cannot tell apart. A reader that needs one arm's answer
   *  reads it here, never off the live registry, which a later concurrent
   *  refresh may already have replaced. */
  listed: { topstep: readonly number[] | null; tradovate: readonly number[] | null };
  /** The ids of `listed` the arm reported with `canTrade: false`; null exactly
   *  where `listed` is. The account-status check's fallback reads them as
   *  dead when Topstep's website account read fails. */
  cannotTrade: { topstep: readonly number[] | null; tradovate: readonly number[] | null };
  /** When each arm's search returned, as an ISO stamp; null exactly where
   *  `listed` is. The status writers compare answers by this time, not by when
   *  a refresh finished — a refresh waiting on its slower arm can finish after
   *  a newer answer about the faster one's accounts. */
  answeredAt: { topstep: string | null; tradovate: string | null };
  /** Each listed id's balance as the arm's search reported it — finite only;
   *  an id whose balance was not a finite number is absent — and null
   *  exactly where `listed` is. **Tradovate's is always null**: its account list
   *  carries no balance and the translator writes `0` in its place, which a
   *  reader would store as a real zero. */
  balances: { topstep: ReadonlyMap<number, number> | null; tradovate: null };
  /** Total accounts in the registry after this refresh. */
  size: number;
  /** Account ids that disappeared between the previous refresh and this
   *  one. A broker whose arm failed contributes nothing here — it reported
   *  nothing, which is not the same claim as "these accounts are gone".
   *
   *  **Diagnostic only. Nothing in `src/` reads it**, and the claim that the
   *  engine treats these as orphan candidates was never true. Orphan-pausing
   *  runs off `maybeOrphanFromBrokerError` — an `AccountNotFound` from a call
   *  the engine actually made — not off this list. `657fb76`'s message says a
   *  carried-forward account "is not reported in `removed`, so a blip cannot
   *  orphan-pause a deployment"; the outcome is right and the mechanism named
   *  is not. The blip cannot orphan-pause because carrying the entries forward
   *  keeps `brokerForAccount` resolving, so no `AccountNotFound` is ever
   *  raised. Left unwired deliberately: consuming it would add a *new*
   *  orphan-pause trigger driven by a fan-out's silence rather than by a
   *  broker's answer, which is the failure mode that commit removed. Wire it
   *  only with that decision made explicitly. */
  removed: number[];
  /** Accounts whose broker routing changed on this refresh. The engine
   *  logs these through its durable log; see `refreshBrokerRegistry`. */
  kindChanges: BrokerKindChange[];
}

export class BrokerRegistry {
  private map = new Map<number, Broker>();
  private brokerByAccount = new Map<number, BrokerKind>();
  private nameByAccount = new Map<number, string>();
  private balanceByAccount = new Map<number, number>();
  private lastFullRefreshAt = 0;

  constructor(private clients: BrokerRegistryClients) {}

  /** Swap the Tradovate REST client at runtime. Used by the settings
   *  hot-reload path so the engine doesn't need a container restart
   *  after credentials are saved or removed. The next `refresh()` call
   *  picks up the new reference automatically.
   *
   *  A non-null client is rebound onto every Tradovate entry at once, so a
   *  refresh whose arm then throws carries its accounts forward through
   *  *this* client — the one the engine and the realtime adapter hold — and
   *  never through the instance the plugin dropped, whose token belongs to
   *  the previous credentials (A76). A null leaves the entries until the
   *  next refresh drops them, as it always has. */
  updateTradovateClient(client: TradovateClient | null): void {
    this.clients.tradovate = client;
    if (!client) return;
    for (const [accountId, kind] of this.brokerByAccount) {
      if (kind === BrokerKind.Tradovate && this.map.has(accountId)) this.map.set(accountId, client);
    }
  }

  /** Read-only accessor — null when no broker is registered. Engine
   *  callers that reach `null` should throw their own scoped error. */
  get(accountId: number): Broker | null {
    return this.map.get(accountId) ?? null;
  }

  /** True iff the given account is currently registered to any broker. */
  has(accountId: number): boolean {
    return this.map.has(accountId);
  }

  /** Broker kind tag for an accountId. Falls back to the persisted
   *  `account_brokers` row when the runtime map hasn't been populated
   *  (e.g. early boot, refresh failed). Returns `'topstep'` for unknown
   *  ids so the default-Topstep semantics survive a fresh install. */
  brokerKind(accountId: number): BrokerKind {
    return this.brokerByAccount.get(accountId) ?? getAccountBrokerOrTopstep(accountId);
  }

  /** ms since the last refresh in which **every configured broker answered**.
   *  A fan-out one arm failed leaves this alone: "some broker answered" is
   *  not "the registry is current", and a caller reading an age wants the
   *  second claim. `RefreshResult.partial` carries the per-call answer. */
  ageMs(): number {
    return this.lastFullRefreshAt === 0 ? Infinity : Date.now() - this.lastFullRefreshAt;
  }

  /** Account-id → name map captured by the most recent fan-out. The
   *  engine's accountNames cache reads from here so the fan-out runs
   *  exactly once per refresh tick (vs. once for the registry + once
   *  for the cache). */
  accountNamesSnapshot(): ReadonlyMap<number, string> {
    return this.nameByAccount;
  }

  /**
   * Account-id → balance, from the most recent fan-out's **answering** arms.
   *
   * Unlike the routing maps beside it, a failed arm contributes nothing here
   * and its previous entries are *not* carried forward: the one reader is the
   * close sampler, which writes the balance it finds as an end-of-day close,
   * and a balance from a fan-out two hours ago is not the close it is looking
   * for. Absent is the honest answer, and the sampler's answer to absent is to
   * write nothing.
   */
  accountBalancesSnapshot(): ReadonlyMap<number, number> {
    return this.balanceByAccount;
  }

  /** Account ids currently registered to this broker. The engine reads it
   *  for the `realtimeAccountScope: "registered"` case — one connection
   *  per account, so every account the registry knows gets a subscriber.
   *  Untagged accounts are excluded. */
  accountIdsForKind(kind: BrokerKind): number[] {
    const out: number[] = [];
    for (const [accountId, tagged] of this.brokerByAccount) {
      if (tagged === kind) out.push(accountId);
    }
    return out;
  }

  /**
   * Fan out `searchAccounts` across configured broker clients and rebuild
   * the registry. Both branches catch their own errors so a single broker
   * outage doesn't take down the catalog for the other.
   *
   * **A partially failed fan-out is not a fan-out.** Each arm contributes
   * only when it answered; a failed arm's previous entries are carried
   * forward verbatim rather than replaced by an empty set. Assigning all
   * three maps unconditionally meant one broker's transient outage erased
   * that broker's whole account set in a single statement, dropping every
   * one of its accounts through to `getAccountBrokerOrTopstep` — which is
   * the map that decides which contract every subsequent order carries.
   * See docs/bugs.md and docs/modules/brokers/README.md.
   *
   * Persists the per-account broker tag so synchronous API routes can
   * consult `getAccountBrokerOrTopstep` without booting a client — for the
   * arms that answered, only. (The example this named, the groups POST
   * mixed-broker check, is deleted: a deployment may span brokers. The
   * routing the tag feeds is unchanged and is what the sentence is about.)
   */
  async refresh(): Promise<RefreshResult> {
    const errors: { topstep: string | null; tradovate: string | null } = {
      topstep: null,
      tradovate: null,
    };
    const listed: { topstep: number[] | null; tradovate: number[] | null } = {
      topstep: null,
      tradovate: null,
    };
    const cannotTrade: { topstep: number[] | null; tradovate: number[] | null } = {
      topstep: null,
      tradovate: null,
    };
    const answeredAt: RefreshResult["answeredAt"] = { topstep: null, tradovate: null };
    let topstepBalances: Map<number, number> | null = null;
    const next = new Map<number, Broker>();
    const nextKind = new Map<number, BrokerKind>();
    const nextName = new Map<number, string>();
    const nextBalance = new Map<number, number>();
    const allAccounts: Account[] = [];

    /** Re-adopt one broker's entries from the previous refresh. Called only
     *  from a catch arm: the client handle is still valid across a failed
     *  `searchAccounts`, and the last answer it gave is a better routing
     *  table than no routing table.
     *
     *  **An arm that answered outranks a carry-forward.** The Tradovate catch
     *  runs after the Topstep success loop, so an unconditional write here
     *  re-routes an account Topstep has *just claimed* back to the broker that
     *  reported nothing at all — the wrong-broker-contract shape the merge
     *  rule exists to prevent, and silent: `kindChanges` is computed after
     *  this, so the collision it manufactures reads as "unchanged". An arm
     *  that reported nothing is not evidence against an id the other broker
     *  answered for. */
    const carryForward = (kind: BrokerKind): void => {
      for (const [accountId, tagged] of this.brokerByAccount) {
        if (tagged !== kind) continue;
        if (nextKind.has(accountId) || next.has(accountId)) continue;
        const broker = this.map.get(accountId);
        if (broker) next.set(accountId, broker);
        nextKind.set(accountId, tagged);
        const name = this.nameByAccount.get(accountId);
        if (name !== undefined) nextName.set(accountId, name);
      }
    };

    if (this.clients.topstep) {
      const topstep = this.clients.topstep;
      try {
        const topstepAccounts = await topstep.searchAccounts();
        answeredAt.topstep = new Date().toISOString();
        for (const a of topstepAccounts) {
          next.set(a.id, topstep);
          nextKind.set(a.id, BrokerKind.Topstep);
          nextName.set(a.id, a.name);
          nextBalance.set(a.id, a.balance);
          allAccounts.push(a);
        }
        listed.topstep = topstepAccounts.map((a) => a.id);
        // Narrowed here, at the broker boundary: a non-finite balance is no
        // reading and is left out rather than carried as a number.
        topstepBalances = new Map(
          topstepAccounts.filter((a) => Number.isFinite(a.balance)).map((a) => [a.id, a.balance]),
        );
        cannotTrade.topstep = topstepAccounts.filter((a) => !a.canTrade).map((a) => a.id);
      } catch (err) {
        errors.topstep = err instanceof Error ? err.message : String(err);
        carryForward(BrokerKind.Topstep);
      }
    }

    if (this.clients.tradovate) {
      try {
        const tradovateAccounts = await this.clients.tradovate.searchAccounts();
        answeredAt.tradovate = new Date().toISOString();
        for (const a of tradovateAccounts) {
          // Tradovate accounts win an id collision — but in practice ids
          // are broker-scoped (Topstep emits Topstep ids, Tradovate emits
          // Tradovate ids) and a collision would be a credential mix-up
          // worth surfacing. Logged loud, not silently coerced.
          if (next.has(a.id)) {
            log.event(
              "account_id_collision",
              "broker-registry",
              `account id ${a.id} returned by both Topstep and Tradovate searchAccounts — keeping Tradovate. Investigate credential or environment mix-up.`,
              { accountId: a.id },
            );
          }
          next.set(a.id, this.clients.tradovate);
          nextKind.set(a.id, BrokerKind.Tradovate);
          nextName.set(a.id, a.name);
          nextBalance.set(a.id, a.balance);
          allAccounts.push(a);
        }
        listed.tradovate = tradovateAccounts.map((a) => a.id);
        cannotTrade.tradovate = tradovateAccounts.filter((a) => !a.canTrade).map((a) => a.id);
      } catch (err) {
        errors.tradovate = err instanceof Error ? err.message : String(err);
        carryForward(BrokerKind.Tradovate);
      }
    } else if (BrokerRegistry.tradovateExpectation() !== "not-expected") {
      // Expected but no client is a failed first login (the plugin nulls its
      // client until one succeeds) or credentials removed under a Tradovate
      // deployment — a failed arm, not an unconfigured one, or the orphan
      // cross-checks read its silence as an answer (A74). No carry-forward:
      // the previous entries hold the client the plugin just dropped, and
      // routing orders through it is not something an outage should buy.
      //
      // `unknown` — the expectation read itself failed — lands here too, and
      // that direction is the fix for A74's second face: this arm decides
      // *attribution*, not just whether to alert, so a SQLite hiccup answering
      // "not expected" leaves `errors.tradovate` null, every cross-check reads
      // the skipped arm as an answer, and Tradovate accounts orphan one way.
      errors.tradovate = TRADOVATE_CLIENT_UNAVAILABLE;
    }

    const removed: number[] = [];
    for (const id of this.map.keys()) {
      if (!next.has(id)) removed.push(id);
    }

    // Computed against the outgoing map, so it has to happen before the
    // swap. An id absent from it is a first sighting, which is how every
    // account enters the registry and is never reported.
    const kindChanges: BrokerKindChange[] = [];
    for (const [accountId, kind] of nextKind) {
      const previous = this.brokerByAccount.get(accountId);
      if (previous === undefined || previous === kind) continue;
      kindChanges.push({
        accountId,
        from: previous,
        to: kind,
        name: nextName.get(accountId) ?? null,
      });
    }

    this.map = next;
    this.brokerByAccount = nextKind;
    this.nameByAccount = nextName;
    // Replaced whole, including for an arm that failed — see
    // `accountBalancesSnapshot`. This is the one map `carryForward` is not
    // allowed to fill.
    this.balanceByAccount = nextBalance;
    if (errors.topstep === null && errors.tradovate === null) {
      this.lastFullRefreshAt = Date.now();
    }

    // Best-effort, like the other two seed sites. This one used to throw
    // through `refresh()`, which is the wrong trade: the in-memory maps
    // above — the runtime source of truth — are already committed by this
    // point, so a SQLite hiccup would discard a fan-out that succeeded and
    // skip everything downstream in `refreshBrokerRegistry()`, including
    // `notifyRefreshFailures`. A real broker outage would then go
    // un-alerted because of an unrelated write error. The upsert is
    // additive and the next refresh or boot re-seeds it.
    //
    // `allAccounts` holds only what an arm actually returned — carried-
    // forward entries are deliberately absent. An outage is not evidence
    // about the accounts it failed to ask about, and this table is what the
    // synchronous routes and the live-account block classify from.
    if (allAccounts.length > 0) {
      try {
        setAccountBrokers(toAccountBrokerSeeds(allAccounts));
      } catch (err) {
        log.event(
          "boot_step_failed",
          "broker-registry",
          `account_brokers seeding failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Tradovate's search lists only accounts that can trade, so a listed id
      // is an `ok` answer — the half of the status a refresh can give. Not
      // Topstep's: its active-only search still lists failed and ineligible
      // accounts, so marking them here would revive a dead account on every
      // refresh; its status is the account-status check's alone. Its own
      // try: the seed failing does not make this answer wrong. Stamped when
      // the search returned, so the writer can refuse it over a newer answer.
      try {
        if (listed.tradovate !== null && answeredAt.tradovate !== null) {
          markAccountsActive(listed.tradovate, answeredAt.tradovate);
        }
      } catch (err) {
        log.event(
          "boot_step_failed",
          "broker-registry",
          `account status write failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      partial: errors.topstep !== null || errors.tradovate !== null,
      errors,
      listed,
      cannotTrade,
      answeredAt,
      balances: { topstep: topstepBalances, tradovate: null },
      size: this.map.size,
      removed,
      kindChanges,
    };
  }

  /**
   * Tradovate is *expected* when its credentials are configured or any
   * managed deployment routes to a Tradovate account.
   *
   * **`unknown` is its own answer and the two callers read it opposite ways.**
   * Both reads are DB reads, so the question can fail to be answered at all —
   * and that is not evidence either way. `refresh()` treats it as expected,
   * because its arm decides how every orphan cross-check *attributes* an
   * absent account and a wrong "not expected" orphans Tradovate accounts with
   * nothing asked (A74). `tradovateExpected()` treats it as not expected,
   * because its question is only whether to wake an operator.
   */
  static tradovateExpectation(): "expected" | "not-expected" | "unknown" {
    try {
      if (getTradovateApiCid()) return "expected";
      const enabled = listManagedDeployments();
      for (const d of enabled) {
        if (getAccountBrokerOrTopstep(d.accountId) === BrokerKind.Tradovate) return "expected";
      }
    } catch {
      // The engine's later boot stages surface the DB error themselves.
      return "unknown";
    }
    return "not-expected";
  }

  /** The alert predicate: only an expected broker's failure is worth waking
   *  an operator for, and an install that never opted in — or one whose DB
   *  could not say — stays silent. Attribution does not go through here; see
   *  {@link tradovateExpectation}. */
  static tradovateExpected(): boolean {
    return BrokerRegistry.tradovateExpectation() === "expected";
  }
}

/** Pretty-print a refresh failure for the Discord alert payload. */
function formatRefreshFailure(errors: RefreshResult["errors"]): string {
  const parts: string[] = [];
  if (errors.topstep) parts.push(`Topstep: ${errors.topstep}`);
  if (errors.tradovate) parts.push(`Tradovate: ${errors.tradovate}`);
  return parts.join(" | ");
}

/** Which of the two Tradovate failures an alert announced. */
type TradovateArmFailure = "search-failed" | "no-client";

/**
 * The Tradovate outage the Discord alert last announced, held by whoever
 * calls `notifyRefreshFailures` (the engine, one per process).
 *
 * **One alert per outage, not per refresh.** Boot, the reconciler's 30-minute
 * poll, every Settings visit and the account-status check's hourly retry all
 * refresh the registry, so a per-refresh alert turned one outage into a
 * stream of identical pages. A change between the two failures is a new
 * episode — their impacts differ — and a refresh whose Tradovate arm did not
 * fail closes it, so the next outage alerts again. The log line still goes
 * out on every failed refresh. An alert that did not reach Discord announced
 * nothing and releases the episode, so the next refresh tries again.
 */
export class TradovateAlertEpisode {
  failing: TradovateArmFailure | null = null;
}

/**
 * React to a refresh outcome. Only fires alerts when the
 * Tradovate broker was *expected* and its fan-out failed — once per outage
 * (`TradovateAlertEpisode`).
 * Topstep failures route through the existing engine-side error paths
 * (Topstep is always expected; engine boot itself can't proceed without it).
 */
export async function notifyRefreshFailures(
  result: RefreshResult,
  episode: TradovateAlertEpisode,
): Promise<void> {
  if (!result.errors.tradovate) {
    // An arm that answered, or one no longer run, ends the episode silently:
    // the next outage alerts again. No recovery embed — a second hand-placed
    // alert in this file is a logging decision (log-escalation.test.ts).
    episode.failing = null;
    return;
  }
  if (!BrokerRegistry.tradovateExpected()) return;
  // Two different failures reach this line and only one of them ran a search:
  // a null client means the arm never left the building, so a line saying
  // `searchAccounts failed` sends the reader to the broker's API for an
  // outage that is a local login.
  const nullClient = result.errors.tradovate === TRADOVATE_CLIENT_UNAVAILABLE;
  const failure: TradovateArmFailure = nullClient ? "no-client" : "search-failed";
  const alreadyAnnounced = episode.failing === failure;
  // Claimed before the await, so two refreshes landing together announce
  // once — and released below if the page never reached Discord.
  episode.failing = failure;
  log.event(
    "boot_broker_arm_failed",
    "broker-registry",
    nullClient
      ? `Tradovate arm skipped with no client (broker expected): ${result.errors.tradovate}`
      : `Tradovate searchAccounts failed (broker expected): ${result.errors.tradovate}`,
  );
  if (alreadyAnnounced) return;
  const delivery = await sendDiscordAlert({
    title: "Tradovate broker unavailable",
    color: 0xe67e22,
    fields: [
      {
        name: "Reason",
        value: formatRefreshFailure(result.errors).slice(0, 1000),
      },
      {
        name: "Impact",
        value: nullClient
          ? // No client is not a slow broker: every order this engine would
            // send to Tradovate has nowhere to go, entries and exits alike,
            // and an open position stays open. Saying only "not checked for
            // removed accounts" understates that to the operator reading the
            // alert at 06:00.
            "Tradovate deployments cannot place or close orders until the client is " +
            "re-attached, and they are not checked for removed accounts meanwhile. " +
            "Topstep deployments unaffected."
          : "Tradovate deployments are not checked for removed accounts until " +
            "Tradovate answers again. Topstep deployments unaffected.",
      },
    ],
  }).catch((): AlertDelivery => "failed");
  // An alert that never arrived announced nothing, so the next refresh that
  // sees the outage tries again. "silenced" is not that: the operator turned
  // notifications off (or set no webhook), and re-trying would page them for
  // an hours-old outage the moment they turn alerts back on. Released only if
  // still ours — a later refresh may have closed or changed the episode.
  if (delivery === "failed" && episode.failing === failure) episode.failing = null;
}

/** Convenience for callers that want the persisted Tradovate-broker
 *  account-id list without instantiating a registry. */
export function listTradovateBrokerAccountIds(): number[] {
  return listAccountIdsForBroker(BrokerKind.Tradovate);
}
