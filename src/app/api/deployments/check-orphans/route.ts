import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { listManagedDeployments } from "@/lib/db/deployments";
import { getAccountBrokerOrNull } from "@/lib/db/account-brokers";
import { orphanAbsentAccounts } from "@/lib/trading/engine/realtime/orphan-attribution";
import { log } from "@/lib/logger";

const handle = engineHandle();

/**
 * Detection site #4, and **nothing in `src/` calls it** — the Deployments
 * page mounted it and went away with its tabs; no surface has picked it up
 * since. It stays because it is the only on-demand check: an orphan created
 * mid-session (e.g. a combine→XFA upgrade between two 30-minute reconciler
 * polls) is otherwise caught at the next tick, and a call by hand or from a
 * future surface is the way to force it. Cross-references every deployment's
 * accountId against the live broker-registry roster (Topstep + optional
 * Tradovate) and routes any orphans through the engine's
 * handleOrphanedAccount, which dedupes against already-orphaned rows.
 *
 * An absent account is attributed to its own broker's arm before anything
 * is paused, as at boot and in the reconciler poll (A74): a broker that did
 * not answer this fan-out is not saying its accounts are gone. The pass is
 * `orphanAbsentAccounts`, which the account-status check runs too.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  try {
    // Force a fresh registry refresh so a brand-new Tradovate account
    // shows up here without waiting on the 30-min reconciler tick.
    const refreshResult = await handle.refreshBrokerRegistry();

    // listManagedDeployments inherits the staging allowlist filter so
    // orphan detection on staging only runs against deployments the
    // engine is actually managing. Disabled rows can't fire orders, so
    // they're not relevant to orphan detection either way.
    const managed = listManagedDeployments();
    // Asked once for every managed account, ahead of the pass: the pass asks
    // synchronously, and the registry is the engine's.
    const registered = new Set(
      await handle.registeredAccountIds(managed.map((d) => d.accountId)),
    );
    const orphanAccountIds = await orphanAbsentAccounts(
      managed,
      refreshResult,
      "page_render_account_check",
      {
        isAccountRegistered: (id) => registered.has(id),
        brokerOf: getAccountBrokerOrNull,
        handleOrphanedAccount: (id, reason) => handle.handleOrphanedAccount(id, reason),
        onSkip: (accountId, reason) =>
          log.event(
            "orphan_check_skipped",
            "engine",
            `Page-mount orphan check skipped for account ${accountId} — ${reason}.`,
            { accountId },
          ),
      },
    );

    return NextResponse.json({ ok: true, orphanedAccountIds: orphanAccountIds });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed orphan check" },
      { status: 502 },
    );
  }
}
