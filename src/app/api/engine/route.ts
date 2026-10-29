import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { listManagedDeployments } from "@/lib/db/deployments";
import type { Deployment } from "@/lib/trading/domain";
import { ENGINE_UNREACHABLE_STATUS, engineHandle, isEngineUnreachable } from "@/lib/trading/engine/handle/select";
import { isPracticeAccount } from "@/lib/brokers/topstep/account-classification";
import { BrokerKind, getAccountBrokerOrTopstep } from "@/lib/db/account-brokers";
import {
  screenBodyDeployments,
  STOP_WHILE_CLOSING_STATUS,
  stopWhileClosingRefusal,
  type WithheldLiveAccount,
  type WithheldNotAllowed,
} from "@/lib/trading/broker-access/engine-entry-screens";
import { log } from "@/lib/logger";
import { runsEngine } from "@/lib/role";

const handle = engineHandle();

// Tracks whether we've already attempted to hydrate from DB in this process.
// We only try once per process so a failed hydrate doesn't loop on every
// request. The user can still trigger start/update manually.
let autoStartAttempted = false;

/**
 * On the first /api/engine request after a process boot, read enabled
 * deployments from the DB and start the engine with them. This is what
 * lets the UI reflect "engine running" after a redeploy without the user
 * having to re-enable each deployment.
 *
 * Returns a NextResponse to short-circuit the request when the boot
 * assertion failed (the server still serves requests after a boot throw,
 * so we can't rely on the process having died). null means "proceed".
 * Other auto-start failures are logged silently and the user can still
 * trigger start manually from the UI.
 */
async function maybeAutoStart(): Promise<NextResponse | null> {
  // Boot assertion is the single source of truth for "is the engine
  // permitted to start." If instrumentation.ts marked it failed, refuse
  // every action that would touch the engine — including auto-start AND
  // manual start from the UI. Fix-forward: operator corrects the env var
  // and restarts the container.
  if ((await handle.getBootAssertionState()) === "failed") {
    return NextResponse.json(
      {
        error: "Engine refused to start: boot assertion failed",
        reason: await handle.getBootAssertionFailureReason(),
      },
      { status: 503 },
    );
  }

  // The engine process boots itself; web never decides to trade. A web
  // process's first status read after a UI-only push would otherwise restart
  // trading the operator had stopped.
  if (!runsEngine()) return null;

  if (autoStartAttempted) return null;
  autoStartAttempted = true;

  try {
    const enabled = listManagedDeployments();
    if (enabled.length === 0) return null;
    if (await handle.isRunning()) return null;
    await handle.start(enabled);
    log.event("boot_started", "engine", `auto-started with ${enabled.length} enabled deployment(s)`);
  } catch (err) {
    log.event("boot_refused", "engine", "auto-start failed", { meta: err });
  }
  return null;
}

// ── POST: start/stop/status/update/logs ─────────────────────────────

export async function POST(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (err) {
    if (!isEngineUnreachable(err)) throw err;
    return NextResponse.json({ error: err.message }, { status: ENGINE_UNREACHABLE_STATUS });
  }
}

async function handlePost(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  const autoStartFail = await maybeAutoStart();
  if (autoStartFail) return autoStartFail;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const raw = body as { action?: unknown; deployments?: unknown; practiceOnly?: unknown; limit?: unknown };
  // Whitelist of accepted actions. Anything outside the list short-circuits
  // before we touch the engine — the default branch's "Unknown action" 400
  // would still catch this but we'd rather not have invalid types reach the
  // engine getter at all.
  const ALLOWED_ACTIONS = new Set([
    "start", "stop", "status", "update", "logs", "reconnectMarketHub", "clearLogs",
  ]);
  if (typeof raw.action !== "string" || !ALLOWED_ACTIONS.has(raw.action)) {
    return NextResponse.json(
      { error: `Invalid action: ${typeof raw.action === "string" ? raw.action : typeof raw.action}` },
      { status: 400 },
    );
  }
  if (raw.deployments !== undefined && !Array.isArray(raw.deployments)) {
    return NextResponse.json({ error: "deployments must be an array" }, { status: 400 });
  }
  if (raw.practiceOnly !== undefined && typeof raw.practiceOnly !== "boolean") {
    return NextResponse.json({ error: "practiceOnly must be a boolean" }, { status: 400 });
  }
  const action = raw.action as "start" | "stop" | "status" | "update" | "logs" | "reconnectMarketHub" | "clearLogs";
  // Strip soft-deleted rows up front. The deployments-page client cache
  // holds both Active and Trash via ?includeTrash=true; the engine never
  // wants to see trash rows, even for validation. start/update strip
  // again defensively before passing to the engine.
  const rawDeployments = raw.deployments as Deployment[] | undefined;
  const deployments = rawDeployments?.filter((d) => d.deletedAt == null);
  const practiceOnly = raw.practiceOnly as boolean | undefined;

  // **No strategy-key check here, deliberately.** It refused the whole start or
  // update over one row whose key the registry does not answer — and a prod
  // build registers only the allowlist in `strategies/prod-playbooks.ts`, so
  // every board resync on prod carries such rows. The engine refuses each one
  // itself at activation and says so once per row — the one refusal that is
  // not entry-only, since no module is left to manage a position out
  // (engine.md) — which is the same answer boot gives the same rows through
  // `listManagedDeployments()`.
  //
  // **The bracket half is gone with the params it validated.** Do not re-add a
  // generic "validate every numeric param against its schema min" sweep here:
  // a playbook's constants are pinned in code and checked by the reviewer
  // against the README's declared ranges.

  // Server-side safety gate: when practiceOnly is on, filter non-PRAC
  // deployments out of the batch instead of rejecting the whole start.
  // Rejecting blocked any practice deploy whenever a live deployment also
  // existed in the cache — making practice-only effectively unusable
  // alongside live deployments. Skipped rows are reported back so the UI
  // can surface "held back by practice-only" without silently dropping them.
  // Account list is fetched from Topstep so a compromised client can't
  // bypass the filter by lying about account names.
  let skippedNonPrac: { id: string; accountId: number; accountName: string | null }[] = [];
  let filteredDeployments = deployments;
  if ((action === "start" || action === "update") && deployments && deployments.length > 0) {
    const enforcePractice = practiceOnly ?? true;
    if (enforcePractice) {
      try {
        // No Topstep client means no Topstep account roster. Fail closed
        // rather than 500: an unverifiable Topstep account falls through
        // to `a == null` below and is held back, while Tradovate rows —
        // already filtered by host — still start. A Topstep *throw* is
        // still a 500, because that is Topstep failing, not absent.
        const accounts = await handle.listTopstepAccounts();
        const accountById = new Map(accounts.map((a) => [a.id, a]));
        const partition = deployments.reduce<{ keep: Deployment[]; skip: typeof skippedNonPrac }>(
          (acc, d) => {
            const a = accountById.get(d.accountId);
            // Topstep accounts: read the `practice` flag the client
            // stamped on the row we just fetched, never a name prefix
            // inlined here — an inlined `startsWith("PRAC")` was a third
            // definition of the rule and the widest of the three.
            // Tradovate accounts won't appear in `accountById` because the
            // search here is Topstep-only; the staging allowlist already
            // filtered them by host (demo-only).
            const broker = a?.broker ?? getAccountBrokerOrTopstep(d.accountId);
            const allowed =
              broker === BrokerKind.Tradovate ? true : a != null && isPracticeAccount(a);
            if (allowed) acc.keep.push(d);
            else acc.skip.push({ id: d.id, accountId: d.accountId, accountName: a?.name ?? null });
            return acc;
          },
          { keep: [], skip: [] },
        );
        filteredDeployments = partition.keep;
        skippedNonPrac = partition.skip;
      } catch (err) {
        if (isEngineUnreachable(err)) throw err;
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Practice-only check failed" },
          { status: 500 },
        );
      }
    }
  }

  // No detached (`orphanReason`) filter here, deliberately: a detached row
  // must stay in the exit loop, and the engine's entry gate refuses its
  // entries off the database row, which no body can clear (engine.md, A75).
  //
  // The live-account block and the staging allowlist on the body-supplied
  // list: start/update take it straight off the POST body, so an
  // authenticated browser could hand the engine a deployment the DB read
  // would have withheld. `practiceOnly` is not the live-account check — it
  // is client-supplied, defaults to true but can be sent false, and only
  // covers the Topstep arm.
  let skippedLiveAccounts: WithheldLiveAccount[] = [];
  let skippedNotAllowed: WithheldNotAllowed[] = [];
  if ((action === "start" || action === "update") && filteredDeployments && filteredDeployments.length > 0) {
    const screened = screenBodyDeployments(filteredDeployments, await handle.getStagingAllowlist(), action);
    filteredDeployments = screened.deployments;
    skippedLiveAccounts = screened.skippedLiveAccounts;
    skippedNotAllowed = screened.skippedNotAllowed;
  }

  // Every action builds the engine, `logs` and `clearLogs` included.
  await handle.ensureEngine();

  switch (action) {
    case "start": {
      if (!filteredDeployments) {
        return NextResponse.json({ error: "Missing deployments" }, { status: 400 });
      }
      await handle.start(filteredDeployments);
      return NextResponse.json({
        running: true,
        skippedNonPrac,
        skippedNotAllowed,
        skippedLiveAccounts,
      });
    }

    case "stop": {
      const refusal = stopWhileClosingRefusal();
      if (refusal) return NextResponse.json(refusal, { status: STOP_WHILE_CLOSING_STATUS });
      await handle.stop();
      return NextResponse.json({ running: false });
    }

    case "update": {
      if (!filteredDeployments) {
        return NextResponse.json({ error: "Missing deployments" }, { status: 400 });
      }
      await handle.sync(filteredDeployments);
      return NextResponse.json({
        running: await handle.isRunning(),
        skippedNonPrac,
        skippedNotAllowed,
        skippedLiveAccounts,
      });
    }

    case "status": {
      const status = await handle.status();
      return NextResponse.json({
        running: status.running,
        marketHub: status.marketHub,
        // Per-seam health (D-8), deliberately alongside `marketHub` rather
        // than folded into it. `marketHub` is one connection's state; this is
        // the three seams the engine depends on. A passive hub with healthy
        // REST bars is degraded on the first and perfectly fine on the
        // second, and the operator needs to be able to tell those apart.
        health: status.health,
        // Deployment id → setup note for every leg the engine reads as armed
        // (the dashboard's ARMED chip). The read the `setupsChanged` frame
        // sends the browser back to; a leg absent here is not armed.
        setups: status.setups,
      });
    }

    case "reconnectMarketHub": {
      // User-triggered from the dashboard sidebar. Mints a fresh Topstep
      // session — will displace whoever else is logged in (CME single-
      // session). Engine surfaces success/failure so the UI can react.
      const result = await handle.reconnectMarketHub();
      return NextResponse.json(result, { status: result.ok ? 200 : 500 });
    }

    case "clearLogs": {
      await handle.clearAllLogs();
      return NextResponse.json({ cleared: true });
    }

    case "logs": {
      // Per-level cap so low-frequency levels (error, warn) stay visible
      // at small limits — heartbeats and info would otherwise crowd out
      // every error from the most-recent N rows. Whitelist the values the
      // UI dropdown offers; anything else falls back to 100.
      const ALLOWED_LIMITS = new Set([25, 50, 100, 500]);
      const requested = typeof raw.limit === "number" ? raw.limit : 100;
      const limit = ALLOWED_LIMITS.has(requested) ? requested : 100;
      return NextResponse.json({ byLevel: await handle.getLogsByLevel(limit) });
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
