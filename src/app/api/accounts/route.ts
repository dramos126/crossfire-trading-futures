import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { readTradovateCredentialsFromDb } from "@/lib/brokers/tradovate/client";
import type { Account } from "@/lib/brokers/types";
import {
  autoTradeVerdictsOrUnverified,
  setAccountBrokers,
  toAccountBrokerSeeds,
} from "@/lib/db/account-brokers";
import { log } from "@/lib/logger";
import type { AutoTradeVerdict } from "@/lib/trading/broker-access/account-trading-policy";
import { getTradovateClientIfConfigured, tradovateAuthError } from "@/lib/trading/engine/engine-singleton";
import { resolveTradovateAppIdentity } from "@/lib/settings/tradovate-defaults";

/** A rejection reason can carry an empty message — Topstep's client builds
 *  `new Error(res.errorMessage ?? …)` and `??` passes `""` straight
 *  through. A soft error field the client renders must never be a blank
 *  string, so substitute a describable one. */
function failureMessage(reason: unknown, fallback: string): string {
  const raw = reason instanceof Error ? reason.message : String(reason);
  return raw.trim() === "" ? fallback : raw;
}

/**
 * Every `searchAccounts` fan-out upserts the catalog — this one included.
 *
 * Without it the live-account block has no working recovery: an account
 * added after the last boot has no `account_brokers` row, so
 * `autoTradeVerdict` refuses it as unclassifiable and tells the operator
 * to reload the dashboard. Reloading hits this route and nothing else, so
 * before this seed the refusal named a recovery that did not recover.
 *
 * Upsert-only, so a failed arm keeps the other broker's names rather than
 * clearing them, and best-effort: the account picker must still render
 * when the write fails.
 */
function seedAccountCatalog(accounts: readonly Account[]): void {
  if (accounts.length === 0) return;
  try {
    setAccountBrokers(toAccountBrokerSeeds(accounts));
  } catch (err) {
    log.event(
      "boot_step_failed",
      "api.accounts",
      `account_brokers seeding failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Each row with the server's auto-trade verdict, read from the catalog the
 * seed above just wrote — the same `autoTradeVerdictsForAccountIds` the deploy
 * routes and the engine ask. The client renders this field and never
 * recomputes it: a row the seed failed to write is refused here as
 * unverified, which the client could not see from the row alone (bugs.md
 * A38). A read that throws refuses every row, the way the gates would.
 */
function withAutoTradeVerdicts(accounts: readonly Account[]): Array<Account & { autoTrade: AutoTradeVerdict }> {
  const verdictFor = autoTradeVerdictsOrUnverified(accounts.map((a) => a.id), "api.accounts");
  return accounts.map((a) => ({ ...a, autoTrade: verdictFor(a.id) }));
}

export async function GET(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;

  try {
    // Ensure appId/appVersion/deviceId are seeded so readTradovateCredentialsFromDb
    // returns non-null even if this runs before the settings GET has fired.
    resolveTradovateAppIdentity();

    // The token lookup lives inside the fan-out arm, not above it: a
    // Topstep auth failure must stay a soft per-broker error, the way a
    // searchAccounts throw already does. Hoisting it would turn a Topstep
    // outage back into a 500 that loses the working Tradovate catalog.
    const fetchTopstep = async (): Promise<Account[]> => {
      const topstepToken = await topstepBrowserToken();
      if (!topstepToken) throw new Error("Topstep is not configured");
      const client = new TopstepClient();
      client.setToken(topstepToken);
      return client.searchAccounts();
    };

    const fetchTradovate = async (): Promise<Account[]> => {
      // Engine singleton, not a fresh client — see /api/positions. This
      // route is not polled, but a fresh client carries a virgin
      // PenaltyResponseHandler, so every dashboard load and every open
      // tab authenticated with no memory of the rate-limit pressure the
      // others had already produced. That is the reconnect-storm shape
      // the plugin's initialize() comment exists to prevent.
      const tradovate = await getTradovateClientIfConfigured();
      // The arm only runs with creds present, so null here means the
      // first authentication failed. Throw rather than return []: this
      // fan-out counts *rejections* to decide between a partial catalog
      // and a 500, and an empty fulfilment would report a total outage
      // as "you have no accounts".
      //
      // The reason comes off the plugin because `initialize()` swallowed
      // the error on the way here. A captcha lockout tells the operator to
      // wait an hour rather than re-check their password; "authentication
      // failed" tells them nothing.
      if (!tradovate) throw new Error(tradovateAuthError() ?? "Tradovate authentication failed");
      const accounts = await tradovate.searchAccounts();
      try {
        const balances = await tradovate.getCashBalances();
        for (const account of accounts) {
          const amount = balances.get(account.id);
          if (typeof amount === "number") account.balance = amount;
        }
      } catch (err) {
        log.event(
          "broker_response_malformed",
          "api.accounts",
          `Tradovate cashBalance fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return accounts;
    };

    // Settled, not sequential: one broker's outage must not take out the
    // other's catalog. This ran Topstep-first inside a shared try, so a
    // Topstep throw was a 500 and the Tradovate accounts — which would
    // have loaded fine — were never fetched. Same semantics as
    // /api/deployments/flatten-all.
    const tradovateConfigured = readTradovateCredentialsFromDb() != null;
    const topstepConfigured = brokerRegistry.getPlugin("topstep")?.isConfigured() === true;
    if (!topstepConfigured && !tradovateConfigured) {
      // Reachable only if credentials were cleared while a session was
      // live. A 200 with zero accounts would render as "you have no
      // accounts" instead of "there is nothing to ask".
      return NextResponse.json({ error: "No broker is configured" }, { status: 503 });
    }
    const [topstepResult, tradovateResult] = await Promise.allSettled([
      topstepConfigured ? fetchTopstep() : Promise.resolve<Account[]>([]),
      tradovateConfigured ? fetchTradovate() : Promise.resolve<Account[]>([]),
    ]);

    const accounts: Account[] = [];
    let topstepError: string | null = null;
    let tradovateError: string | null = null;

    if (topstepResult.status === "fulfilled") {
      accounts.push(...topstepResult.value);
    } else {
      topstepError = failureMessage(topstepResult.reason, "Failed to fetch Topstep accounts");
      log.event("boot_broker_arm_failed", "api.accounts", `Topstep fan-out failed: ${topstepError}`);
    }

    if (tradovateResult.status === "fulfilled") {
      accounts.push(...tradovateResult.value);
    } else {
      tradovateError = failureMessage(tradovateResult.reason, "Failed to fetch Tradovate accounts");
      log.event(
        "boot_broker_arm_failed",
        "api.accounts",
        `Tradovate fan-out failed: ${tradovateError}`,
      );
    }

    // Every broker we actually attempted failed — there is no partial
    // catalog to render, so keep the hard error the dashboard's connect
    // path latches onto rather than a silently empty account picker.
    //
    // Counted on the settled statuses, never on the message strings: a
    // broker can reject with an empty message (Topstep's client does
    // `new Error(res.errorMessage ?? …)`, and `??` does not catch `""`),
    // and counting truthiness of those strings undercounts a total
    // outage into a 200 with zero accounts.
    const attempted = (topstepConfigured ? 1 : 0) + (tradovateConfigured ? 1 : 0);
    const failed =
      (topstepResult.status === "rejected" ? 1 : 0) +
      (tradovateResult.status === "rejected" ? 1 : 0);
    if (failed === attempted) {
      return NextResponse.json(
        { error: topstepError || tradovateError, topstepError, tradovateError },
        { status: 500 },
      );
    }

    seedAccountCatalog(accounts);

    return NextResponse.json({ accounts: withAutoTradeVerdicts(accounts), tradovateError, topstepError });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch accounts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
