import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { readTradovateCredentialsFromDb } from "@/lib/brokers/tradovate/client";
import { BrokerKind, getAccountBrokerOrNull } from "@/lib/db/account-brokers";
import { getTradovateClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { log } from "@/lib/logger";

/** Enough to name what is blocking in a log line, and nothing else.
 *  Keeping the projection narrow means the cache holds nothing a caller
 *  could be tempted to read stale. The gate itself compares on the
 *  account — see {@link hasOpenPositionOnBroker}. */
export interface OpenPositionRef {
  contractId: string | null;
}

export type OpenPositionLookup = (accountId: number) => Promise<OpenPositionRef[]>;

/**
 * Per-account, cached, fail-closed open-position reader.
 *
 * The cache holds the in-flight promise, so a group with N legs across K
 * accounts costs at most K broker hits — and a broker failure is cached
 * too, so a down broker is hit once and every leg on that account fails
 * the same way instead of retrying into a broker that is already down.
 *
 * Every unknown answer throws. Both consumers read a throw as "in
 * position": the route gates via `legHasOpenPositionWithFallback`'s catch
 * arm, the boot pre-flight via `runPendingSessionMigrations`'. An
 * unreachable broker must never read as "flat" on a path that can abandon
 * a live position.
 */
function cachedLookup(brokerFor: (accountId: number) => Promise<Broker>): OpenPositionLookup {
  const cache = new Map<number, Promise<OpenPositionRef[]>>();
  return (accountId: number): Promise<OpenPositionRef[]> => {
    const cached = cache.get(accountId);
    if (cached) return cached;
    const pending = (async () => {
      const broker = await brokerFor(accountId);
      const positions = await broker.searchOpenPositions(accountId);
      // Topstep hands back `res.positions` with no runtime validation and
      // no filtering, so a response carrying another account's rows would
      // — under the account-scoped comparison in
      // `hasOpenPositionOnBroker` — block every gate on this account.
      // Drop only rows that name a *different* account: a missing
      // `accountId` is an unknown, and on this path unknowns stay in.
      // (Tradovate's client already filters; this covers both.)
      return positions
        .filter((p) => typeof p.accountId !== "number" || p.accountId === accountId)
        .map((p) => ({ contractId: p.contractId }));
    })();
    cache.set(accountId, pending);
    return pending;
  };
}

/** The narrowest row shape the comparison needs — a `Deployment` leg
 *  satisfies it structurally. Deliberately does *not* include
 *  `contractId`; see {@link hasOpenPositionOnBroker}. */
export interface OpenPositionSubject {
  accountId: number;
}

/**
 * The comparison every open-position gate runs, in one place: the three
 * group-route gates and the boot session-migration pre-flight.
 *
 * **The question is "does this leg's account hold any open position", not
 * "does it hold one on this leg's contract".** This used to open with
 * `if (!leg.contractId) return false`, and `deployment.contract_id` is
 * null on every row that has ever existed — the UI posts null at
 * creation, group/add-leg/promote copy the parent's null, and no code
 * path writes a non-null value. So the broker arm of the gate had never
 * once executed: it answered "flat" before any broker was asked, on
 * every leg, for both brokers. An operator removing a leg while the
 * engine was down abandoned a live position to its resting brackets with
 * no engine supervision. Filed Critical in docs/bugs.md, fixed here.
 *
 * Account scope is the conservative half of that fix. It over-blocks — a
 * leg whose account holds an unrelated position on another contract is
 * refused — and that is the intended trade on a path that can strand
 * real money. The alternative, resolving the contract on demand, adds a
 * resolver call that can itself fail to a destructive-op path, buying
 * precision with a new failure mode. Do not narrow this back to a
 * contract comparison on the strength of `contract_id` starting to be
 * populated; that would silently re-scope a safety gate.
 *
 * The over-blocking is logged with the contracts responsible, so "why is
 * my flat leg refused" is answerable from /logs rather than by reading
 * this comment.
 */
export async function hasOpenPositionOnBroker(
  lookup: OpenPositionLookup,
  row: OpenPositionSubject,
): Promise<boolean> {
  const positions = await lookup(row.accountId);
  if (positions.length === 0) return false;
  log.warn(
    "trading.gate",
    `Account ${row.accountId} holds ${positions.length} open position(s) ` +
      `[${positions.map((p) => p.contractId ?? "unknown contract").join(", ")}] — ` +
      `open-position gate is blocking every deployment on this account, ` +
      `including any whose own contract is flat`,
  );
  return true;
}

/**
 * Which broker owns this account, or a throw.
 *
 * `getAccountBrokerOrTopstep`'s default is load-bearing everywhere else —
 * every pre-existing install's accounts are implicitly Topstep — but on
 * this path it is a wrong answer wearing a definitive answer's clothes: a
 * Topstep client asked about a Tradovate account id returns
 * `positions: []` and the gate opens on a live position. Reachable on a
 * mixed install, because a `BrokerRegistry.refresh()` whose Tradovate arm
 * throws leaves new Tradovate accounts untagged.
 *
 * So the default only survives where it cannot be wrong: no Tradovate
 * credentials means no Tradovate account can exist, and untagged is
 * Topstep. With Tradovate configured, untagged is unknown and unknown
 * throws — the caller's fail-closed arm reads that as "in position".
 */
function resolveBrokerKind(accountId: number): BrokerKind {
  const tagged = getAccountBrokerOrNull(accountId);
  if (tagged) return tagged;
  if (readTradovateCredentialsFromDb() != null) {
    throw new Error(
      `Account ${accountId} has no broker tag and Tradovate is configured — ` +
        `cannot verify open positions without knowing which broker owns it`,
    );
  }
  return BrokerKind.Topstep;
}

async function tradovateBrokerFor(accountId: number): Promise<Broker> {
  // Singleton client, not a fresh one: a per-request Tradovate client
  // re-authenticates and can trip the broker-unavailable circuit.
  const client = await getTradovateClientIfConfigured();
  if (!client) {
    throw new Error(
      `Tradovate client unavailable — cannot verify open positions for account ${accountId}`,
    );
  }
  return client;
}

/**
 * Route-side variant, for the destructive-op gates (group session edit,
 * group soft-delete, remove-leg, convert-to-standalone). Topstep accounts
 * go through a client stamped with the plugin's browser JWT; Tradovate
 * accounts through the engine singleton's client.
 *
 * The JWT is fetched lazily, on first sight of a Topstep account, and an
 * absent or unmintable one throws — the caller's fail-closed arm reads a
 * throw as "in position". A Tradovate-only install therefore never asks
 * Topstep for anything here and never trips on its absence.
 */
export function createOpenPositionLookup(): OpenPositionLookup {
  let topstep: TopstepClient | null = null;
  return cachedLookup(async (accountId) => {
    if (resolveBrokerKind(accountId) === BrokerKind.Tradovate) {
      return tradovateBrokerFor(accountId);
    }
    if (!topstep) {
      const token = await topstepBrowserToken();
      if (!token) {
        throw new Error(
          `No Topstep token — cannot verify open positions for account ${accountId}`,
        );
      }
      topstep = new TopstepClient();
      topstep.setToken(token);
    }
    return topstep;
  });
}

/**
 * Boot-side variant, for the session-migration pre-flight. There is no
 * browser token at boot, so the caller passes the plugin's already-
 * authenticated Topstep client; Tradovate is resolved on first sight of a
 * Tradovate-tagged account so a Topstep-only install never touches it.
 *
 * `topstep` is null on a Tradovate-only install, where a Topstep-routed
 * account should not exist — and if one does, it throws, which the
 * migration reads as "in position" and leaves the row intact. Never
 * answer "flat" for a broker nobody asked.
 *
 * `account_brokers` is the persisted projection of the runtime registry
 * and this runs before the engine's first refresh, so `boot-engine` seeds
 * the table from its own account fan-out immediately beforehand. Without
 * that seeding an untagged account with Tradovate configured is unknown,
 * and unknown fails closed — which blocked migration entirely.
 */
export function createBootOpenPositionLookup(topstep: Broker | null): OpenPositionLookup {
  return cachedLookup(async (accountId) => {
    if (resolveBrokerKind(accountId) === BrokerKind.Tradovate) {
      return tradovateBrokerFor(accountId);
    }
    if (!topstep) {
      throw new Error(
        `Account ${accountId} routes to Topstep but no Topstep client is configured — ` +
          `cannot verify open positions`,
      );
    }
    return topstep;
  });
}
