import {
  listManagedDeployments,
  readManagedDeployments,
  runPendingSessionMigrations,
} from "@/lib/db/deployments";
import { getEngine, getEngineIfReady } from "@/lib/trading/engine/engine-singleton";
import { brokerRegistry } from "@/lib/brokers/registry-singleton";
import type { TopstepBrokerPlugin } from "@/lib/brokers/topstep/index";
import type { TradovateBrokerPlugin } from "@/lib/brokers/tradovate/index";
import type { TopstepClient } from "@/lib/brokers/topstep/client";
import type { Account } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import {
  BrokerKind,
  getAccountBrokerOrNull,
  setAccountBrokers,
  toAccountBrokerSeeds,
} from "@/lib/db/account-brokers";
import { attributeAbsentAccount } from "@/lib/trading/engine/realtime/orphan-attribution";
import {
  createBootOpenPositionLookup,
  hasOpenPositionOnBroker,
} from "@/lib/trading/broker-access/open-position-lookup";
import { log } from "@/lib/logger";
import { isPracticeAccount } from "@/lib/brokers/topstep/account-classification";
import { markBootAssertionPassed, markBootAssertionFailed } from "@/lib/trading/engine/boot/boot-assertion";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { setStagingAllowlist } from "@/lib/trading/broker-access/staging-allowlist";
import { setMigrationBlocked } from "@/lib/trading/session/session-migration-status";
import { isStagingEnv } from "@/lib/env";
import { cleanupExpiredOrderMappings } from "@/lib/db/tradovate-order-map";
import {
  getAllOpenTrades,
  getOpenTradeForDeployment,
  listAccountsWithReconcilableTrades,
} from "@/lib/db/trades";
import { runBookReconcile } from "@/lib/trading/books/reconcile";
import { runRetireOffCellRows } from "@/lib/trading/books/retire-off-cell-rows";
import { registeredStrategyKeys } from "@/lib/trading/strategies";
import { prodRegistryMismatch } from "@/lib/trading/strategies/prod-playbooks";
import { reportBookMigrations } from "@/lib/db/books";
import {
  evaluateRestart,
  formatGapDuration,
  installCleanShutdownMarker,
  readOwedFlatten,
  startLeaseRenewal,
  startProcessLiveness,
  RESUME_FLAP_LIMIT,
  RESUME_FLAP_WINDOW_MS,
  UNMANAGED_FLATTEN_MS,
  type RestartVerdict,
} from "@/lib/trading/engine/boot/engine-restart";
import type { PendingFlatten } from "@/lib/db/engine-restart";
import {
  describeLeaseHolder,
  handoffAcceptedBy,
  leaseHolderId,
  refreshHandoffRequest,
  releaseLease,
  reportLeaseRefused,
  requestHandoff,
  tryAcquireLease,
  withdrawHandoff,
  LEASE_FRESH_MS,
} from "@/lib/db/lease";
import { holdTokenRefresh } from "@/lib/brokers/topstep/auth";
import { isShutdownStarted, registerPreCloseHook } from "@/lib/db/connection";
import { markShutdownDraining, SHUTDOWN_EXIT_CAP_MS } from "@/lib/shutdown-drain";
import { EngineNotInThisProcessError, runsEngine } from "@/lib/role";
import type { HubReadiness } from "@/lib/trading/engine/engine";
import { sendDiscordAlert, COLOR_CONNECTION_LOST, COLOR_EXIT_LOSS } from "@/lib/notify/discord";

/** One `searchAccounts()` per configured broker, `allSettled` so one
 *  broker's outage cannot take out the other's catalog — the shape
 *  `/api/deployments/flatten-all` already uses. `attempted` counts the
 *  brokers we actually asked, so "everything failed" is distinguishable
 *  from "nothing was configured". */
interface BrokerAccountFanOut {
  accounts: Account[];
  attempted: number;
  failures: string[];
  /** Configured brokers this fan-out was told not to ask. */
  heldBack: BrokerKind[];
}

/** Which configured brokers a fan-out asks. */
interface FanOutArms {
  topstep: boolean;
  tradovate: boolean;
}

const EVERY_ARM: FanOutArms = { topstep: true, tradovate: true };

/**
 * A standby's boot asks Topstep only. Every Tradovate `accessTokenRequest`
 * opens a session, the user gets two, and a third closes the oldest — which
 * at a hand-off is the draining engine's, whose exits then 401. So the
 * standby logs in to Tradovate at takeover, after the active has exited.
 */
const STANDBY_ARMS: FanOutArms = { topstep: true, tradovate: false };

async function fanOutBrokerAccounts(ask: FanOutArms = EVERY_ARM): Promise<BrokerAccountFanOut> {
  const arms: Array<{ kind: BrokerKind; run: () => Promise<Account[]> }> = [];
  const heldBack: BrokerKind[] = [];

  const topstepPlugin = brokerRegistry.getPlugin("topstep") as TopstepBrokerPlugin | null;
  if (topstepPlugin?.isConfigured() && !ask.topstep) heldBack.push(BrokerKind.Topstep);
  if (topstepPlugin?.isConfigured() && ask.topstep) {
    arms.push({
      kind: BrokerKind.Topstep,
      run: async () => (await getTopstepClientFromPlugin()).searchAccounts(),
    });
  }

  const tradovatePlugin = brokerRegistry.getPlugin("tradovate") as TradovateBrokerPlugin | null;
  if (tradovatePlugin?.isConfigured() && !ask.tradovate) heldBack.push(BrokerKind.Tradovate);
  if (tradovatePlugin?.isConfigured() && ask.tradovate) {
    arms.push({
      kind: BrokerKind.Tradovate,
      run: async () => {
        // Lazy-init mirrors engine-singleton.getTradovateClientIfConfigured.
        // Boot-engine runs before the engine-singleton boot loop fires
        // `plugin.initialize()`, so on cold-start the client is still null.
        await tradovatePlugin.initialize();
        const client = tradovatePlugin.getClient();
        if (!client) throw new Error("Tradovate client unavailable after initialize()");
        return client.searchAccounts();
      },
    });
  }

  const settled = await Promise.allSettled(arms.map((a) => a.run()));
  const accounts: Account[] = [];
  const failures: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      accounts.push(...result.value);
      return;
    }
    const reason =
      result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(`${arms[i].kind}: ${reason}`);
    log.event(
      "boot_broker_arm_failed",
      "engine",
      `boot: ${arms[i].kind} searchAccounts failed: ${reason}`,
    );
  });

  return { accounts, attempted: arms.length, failures, heldBack };
}

async function getTopstepClientFromPlugin(): Promise<TopstepClient> {
  const plugin = brokerRegistry.getPlugin("topstep") as TopstepBrokerPlugin | null;
  if (!plugin) {
    throw new Error("Topstep plugin not registered in brokerRegistry");
  }
  let client = plugin.getClient();
  if (!client) {
    // boot-engine runs ahead of `getEngine()` (the engine-singleton boot
    // loop that normally fires `plugin.initialize()`), so on cold-start
    // the plugin's client is still null here. Mirror engine-singleton's
    // `getEngineClient()` lazy-init pattern: call initialize, then read
    // the client back.
    await plugin.initialize();
    client = plugin.getClient();
  }
  if (!client) {
    throw new Error(
      "Topstep client unavailable — credentials missing or plugin initialize() failed",
    );
  }
  return client;
}

/**
 * Phase 6b shared boot helper. The engine boot sequence used to live
 * only in `instrumentation.ts`; with the wizard we need the same
 * sequence to fire on demand when /api/settings/setup persists creds
 * for the first time. Inlining the logic in two places risks drift —
 * one tweak applied to one path but not the other would silently
 * change behavior on cold-start vs wizard-start. Single helper, one
 * source of truth.
 *
 * The two callers differ in their failure tolerance:
 *  - instrumentation: any failure swallows into a log.error so the
 *    server still boots (operator can recover via the UI)
 *  - activateFromSettings (wizard): returns `staging-allowlist-empty`
 *    instead of throwing, so the caller can tell a refused boot from a
 *    completed one. That distinction stops at the setup route, which
 *    fire-and-forgets the activation — the wizard learns only from its
 *    /api/auth poll timing out, never from the POST response.
 *
 * The helper itself returns a `BootResult` discriminated by the failure
 * kind; each caller decides what to do with it.
 */

export type BootResult =
  | { kind: "started"; deploymentCount: number }
  | { kind: "no-deployments" }
  /** Enabled rows existed and a post-SQL filter dropped every one of them
   *  — the live-account block on prod, the staging allowlist on staging.
   *  Distinct from `no-deployments` because the operator's next move is
   *  different: this one is a broker outage at seed time or an account
   *  that does not belong on staging, not an empty deployment list. */
  | { kind: "all-withheld"; withheldCount: number }
  | { kind: "no-enabled-after-orphan-check" }
  | { kind: "already-running" }
  | { kind: "staging-allowlist-empty"; message: string }
  | { kind: "error"; message: string };

interface BootOptions {
  /** When the wizard fires this, bubble allowlist failures back so the
   *  route can surface them inline. Cold-start sets this to false so
   *  the existing behavior (log + throw) is preserved. */
  rethrowAllowlistFailure?: boolean;
  /** Cold start only: when `instrumentation.register()` was entered and the
   *  database opened, in ms since process start. The wizard path has none. */
  processMarks?: { registerEnteredMs: number; dbOpenMs: number };
}

/** The boundaries `runBootSequence` reports, in the order it passes them. */
const BOOT_STAGES = [
  ["registerEntered", "register"],
  ["dbOpen", "database open"],
  ["leaseAcquired", "lease acquired"],
  ["restartClassified", "restart classified"],
  ["accountsFannedOut", "accounts fanned out"],
  // A standby's takeover only: the Tradovate login its boot held back.
  ["heldBackArmsAsked", "held-back arms asked"],
  ["hubsReady", "hubs ready"],
  ["realtimePreflightPassed", "realtime check"],
  ["booksReconciled", "books reconciled"],
  ["engineStarted", "engine started"],
] as const;
type BootStage = (typeof BOOT_STAGES)[number][0];

/**
 * The deploy measurement for one pass through `runBootSequence`: ms since
 * process start at each stage reached, emitted once as `boot_timing` however
 * the pass ends. The numbers are in the message as well as in `meta`, because
 * `meta` reaches the console only and the ring behind `/api/engine` and
 * `/logs` carries the message.
 */
class BootTiming {
  private readonly marks = new Map<BootStage, number>();
  private sincePreviousShutdownMs: number | null = null;
  private shutdownToProcessStartMs: number | null = null;

  constructor(processMarks: BootOptions["processMarks"]) {
    if (!processMarks) return;
    this.marks.set("registerEntered", Math.round(processMarks.registerEnteredMs));
    this.marks.set("dbOpen", Math.round(processMarks.dbOpenMs));
  }

  mark(stage: BootStage): void {
    this.marks.set(stage, Math.round(performance.now()));
  }

  /** The consumed marker's instant: how long since the previous process was
   *  told to stop, and how much of that passed before this one started. */
  previousShutdownAt(markerMs: number): void {
    this.sincePreviousShutdownMs = Date.now() - markerMs;
    this.shutdownToProcessStartMs = Math.round(performance.timeOrigin - markerMs);
  }

  report(outcome: string): void {
    const reached = BOOT_STAGES.filter(([stage]) => this.marks.has(stage));
    const stages = reached.map(([stage, label]) => `${label} ${this.marks.get(stage)}`).join(", ");
    const gap =
      this.sincePreviousShutdownMs == null
        ? ""
        : `; ${this.sincePreviousShutdownMs}ms since the previous process was told to stop, ` +
          `${this.shutdownToProcessStartMs} of them before this process started`;
    log.event(
      "boot_timing",
      "engine",
      `boot: timing (${outcome}), ms since process start — ${stages || "no stage reached"}${gap}`,
      {
        meta: {
          outcome,
          ...Object.fromEntries(reached.map(([stage]) => [`${stage}Ms`, this.marks.get(stage)])),
          ...(this.sincePreviousShutdownMs == null
            ? {}
            : {
                sincePreviousShutdownMs: this.sincePreviousShutdownMs,
                shutdownToProcessStartMs: this.shutdownToProcessStartMs,
              }),
        },
      },
    );
  }
}

/** The outcome a pass that threw reports, in place of a `BootResult` kind. */
const BOOT_THREW = "threw";

/**
 * The hub half of the idle-boot line, from what `ensureHubsReady` observed.
 *
 * Exported for its test, for the reason [copy.md](../../../../../docs/modules/ui/copy.md)
 * gives: these strings are the only place an operator is told whether the
 * boot came up healthy, and nothing else fails when one drifts from the
 * code.
 *
 * Two states past the "nothing was started" arm, not three. A third —
 * *"this install has no account feed to relay"* — was written for a
 * `HubReadiness.user` of `null`, which `ensureHubsReady` cannot produce:
 * past its own `signalr` guard the broadcaster is always there, so `user`
 * is always a reading. An arm that can never print is the same defect as
 * the fixed `(hubs ready)` string, so it is gone rather than
 * defensive. See {@link HubReadiness}.
 */
export function describeHubReadiness(hubs: HubReadiness): { text: string; healthy: boolean } {
  if (!hubs.attempted) {
    // What was observed, not what the config says. `this.signalr` is null
    // for two different reasons — Topstep unconfigured, or realtime bars
    // off — and naming only the second is a claim this function cannot
    // check.
    return { text: "No Topstep hubs were started, so there is no feed to report on.", healthy: true };
  }
  const down: string[] = [];
  if (!hubs.market) down.push("market data");
  if (!hubs.user) down.push("the account feed");
  if (down.length === 0) {
    return { text: "Market data and the account feed are both connected.", healthy: true };
  }
  // Sentence-cased: this renders after `… engine idle.`, so a lowercase
  // head reads as a fragment of the clause before it.
  const feeds = down.join(" and ");
  return {
    text: `${feeds.charAt(0).toUpperCase()}${feeds.slice(1)} did not come up — see the errors above. The engine will accept a deployment and sit blind until a feed reconnects.`,
    healthy: false,
  };
}

/** Memoised for the life of the process — see the note inside `classifyBoot`. */
let bootVerdict: RestartVerdict | null = null;

/**
 * Classify this boot against the previous process, alarm if it warrants one,
 * and arrange for the next stop to leave a marker.
 *
 * **Runs ahead of every early return in `runBootSequence`, and that placement
 * is load-bearing.** `evaluateRestart` *consumes* the clean-shutdown marker,
 * which is what stops one clean shutdown from making every later crash read as
 * intentional — so a boot that skipped it (no deployments, allowlist empty,
 * bad realtime slot) would leave the marker behind for a later boot to
 * misread. The alarm belongs here for the same reason: a crash is a
 * reliability signal, and an install that is idle today still had one.
 *
 * Best-effort throughout: a database that cannot answer must not take out
 * boot, so a throw yields an inert verdict — no flatten, no suspension, and a
 * warning saying the duration rule is not being applied this boot.
 */
async function classifyBoot(): Promise<RestartVerdict> {
  installCleanShutdownMarker();

  // Once per process, not once per call. `runBootSequence` has two callers —
  // cold start and the wizard's `activateFromSettings` — and on a first-run
  // install both fire in the same process. A second classification would find
  // the marker already consumed and the heartbeat freshly stamped by the
  // engine the first call started, i.e. it would read a *running* engine as a
  // crash: a false alarm and a false flap cycle, in the counter that decides
  // whether to stop entering.
  if (bootVerdict) return bootVerdict;

  let verdict: RestartVerdict;
  let classified = true;
  try {
    verdict = evaluateRestart();
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: restart classification failed (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
    );
    verdict = {
      gapMs: null,
      clean: false,
      flatten: false,
      alarm: false,
      heartbeatDegraded: false,
      flapCycles: 0,
      entriesSuspended: false,
    };
    classified = false;
  }
  bootVerdict = verdict;

  // **Classify, then stamp — never the other way round, and one call site so
  // an eighth early return cannot skip it.** The liveness stamper writes
  // `last_seen_at` for as long as the process lives, which is what stops an
  // idle box reading its own idleness as unmanaged time (A57) — and it erases
  // the gap it is stamping over, so starting it ahead of `evaluateRestart()`
  // would destroy the one measurement the duration rule exists to make. It
  // starts on the failed-classification arm too: that boot read nothing, but
  // it is alive, and the *next* boot deserves a real number.
  //
  // **The gate is composed here rather than imported there**, because
  // `engine-singleton` → `engine` → `engine-restart` is already an edge and
  // reaching back up for the singleton would close it into a cycle. This file
  // imports both sides already. `listAccountsWithReconcilableTrades` is the
  // canonical "any row still needs reconciling" reader —
  // `pending_entry | open | pending_exit`, the same set `hasOpenTrade`
  // answers per deployment — so there is no second copy of that predicate.
  startProcessLiveness({
    engineRunning: () => getEngineIfReady()?.isRunning() ?? false,
    openTradesExist: () => listAccountsWithReconcilableTrades().length > 0,
  });
  if (!classified) return verdict;

  if (verdict.gapMs == null) {
    log.event(
      "boot_no_prior_heartbeat",
      "engine",
      "boot: no prior engine heartbeat — nothing went unmanaged",
    );
    return verdict;
  }

  // The heartbeat now measures process liveness rather than ticks (A57), so
  // the gap is the stop-to-start window and nothing else. The wording stays
  // "no engine activity": it is what the column can prove, and a degraded
  // heartbeat still makes the number a failed write rather than an absence.
  const gap = formatGapDuration(verdict.gapMs);
  const how = verdict.clean
    ? "previous process stopped cleanly"
    : "unclean stop — no shutdown marker";
  // Three arms, not two: a gap the duration rule cannot trust is neither "past
  // the threshold, flattening" nor "inside the threshold, all well". Saying
  // the second about a twelve-minute gap the previous process spent trading
  // with an unwritable database is the sentence that would stop anyone
  // investigating.
  const positions = verdict.flatten
    ? `Past the ${Math.round(UNMANAGED_FLATTEN_MS / 60_000)}min duration rule — any open position will be force-flattened. `
    : verdict.heartbeatDegraded
      ? "The previous process could not write its heartbeat, so that number measures a failed write rather than unmanaged time. " +
        "The duration rule is not being applied on this boot and open positions are kept — check the database before trusting the next one. "
      : `Positions kept: inside the ${Math.round(UNMANAGED_FLATTEN_MS / 60_000)}min duration rule, and the brackets were live at the broker throughout. `;
  if (!verdict.alarm) {
    log.event(
      "boot_gap_within_rule",
      "engine",
      `boot: no engine activity for ${gap} (${how}) — inside the ${Math.round(UNMANAGED_FLATTEN_MS / 60_000)}min duration rule, positions kept`,
    );
    return verdict;
  }

  log.event(
    "boot_gap_exceeds_rule",
    "engine",
    `boot: no engine activity for ${gap} (${how}). ` +
      positions +
      (verdict.entriesSuspended
        ? `Flap breaker tripped: ${verdict.flapCycles} crash-resume cycles inside ${Math.round(RESUME_FLAP_WINDOW_MS / 60_000)}min (limit ${RESUME_FLAP_LIMIT}) — entries are suspended for this process while open positions keep being managed.`
        : `${verdict.flapCycles} crash-resume cycle(s) inside ${Math.round(RESUME_FLAP_WINDOW_MS / 60_000)}min.`),
  );

  void sendDiscordAlert({
    title: verdict.flatten
      ? "Engine restarted past the duration rule — flattening any open position"
      : verdict.heartbeatDegraded
        ? "Engine restarted — the duration rule could not be applied"
        : "Engine restarted after an unclean stop",
    color: verdict.flatten ? COLOR_EXIT_LOSS : COLOR_CONNECTION_LOST,
    fields: [
      {
        name: verdict.heartbeatDegraded ? "Last heartbeat" : "No engine activity for",
        value: verdict.heartbeatDegraded
          ? `${gap} ago — the previous process could not write it, so this is not a measure of unmanaged time`
          : gap,
      },
      { name: "Previous stop", value: how },
      {
        name: "Positions",
        value: verdict.flatten
          ? "Any open position is force-flattened on this boot, per the duration rule."
          : verdict.heartbeatDegraded
            ? "Kept — the duration rule was not applied, because the heartbeat it reads was unwritable."
            : "Kept — the gap was inside the duration rule and broker brackets covered it.",
      },
      {
        name: "Entries",
        value: verdict.entriesSuspended
          ? `Suspended: ${verdict.flapCycles} crash-resume cycles in ${Math.round(RESUME_FLAP_WINDOW_MS / 60_000)} minutes.`
          : "Resumed, with any signal standing before the stop discarded.",
      },
    ],
  });

  return verdict;
}

/**
 * What the downtime sweep is owed on this boot: whatever a previous boot
 * recorded and never finished, plus this boot's own set when the duration rule
 * fired.
 *
 * **The carried half is read regardless of `restart.flatten`, and that is the
 * whole point of it.** D-7 requires the obligation to survive the process, and
 * the sweep's own retry loop is the likeliest thing to interrupt: the broker
 * being unreachable is the most likely cause of the outage it is cleaning up
 * after, so it retries every 15s and reports every 5 min, and the ordinary
 * operator response to that line is to restart the container. The heartbeat
 * was stamped throughout those retries, so the next boot measures seconds and
 * classifies "keep" — and gating the re-seed on this boot's verdict is exactly
 * how the set would be dropped, silently, at the moment it still mattered.
 *
 * This boot's own half is read from the trade rows, so deciding costs no
 * broker call, and it is scoped to `Active`: a `Pausing` or `Destroying` row
 * is already owed the same flatten by the closing guard, which has a status
 * behind it and survives a restart holding it.
 *
 * The gap is the larger of the two, because a carried obligation was created
 * by an outage this boot did not measure. **The seed instant is not merged at
 * all**: each half was taken on at its own instant and keeps it, because the
 * instant is a property of the *obligation* and the two obligations are about
 * two different positions. Collapsing them to one threshold discards a real
 * flatten — a position opened after the carried instant but held across *this*
 * boot's outage belongs to this boot's half, and the earlier threshold reads it
 * as "started after the sweep was seeded" and drops it. An id owed by **both**
 * halves takes this boot's instant, not the earlier one: the obligation may be
 * the older of the two, but the position the sweep will meet under that id is
 * the fresh half's — it is open right now, so it predates this instant by
 * construction and refusing it discards a real flatten. A **carried-only** id
 * is untouched by that branch and keeps its own instant, which is where the
 * refusal actually lives. A carried entry with no instant of its own — a
 * legacy payload whose ids had none — already has this read's substituted by
 * `readOwedFlatten`, which is the only place that substitution happens.
 *
 * **The gap travels with a non-empty set only.** `persist()` writes it on every
 * mutation including the one that empties the set, and the carried half below
 * returns nothing to write it back down with, so an eleven-minute outage would
 * silently adopt the last obligation's four hours and report it on every
 * incident surface there is.
 */
function collectOwedFlatten(
  restart: RestartVerdict,
  managed: readonly Deployment[],
  nowMs: number = Date.now(),
): PendingFlatten {
  const owed = new Map<string, number>();
  let gapMs = 0;

  try {
    const carried = readOwedFlatten();
    for (const entry of carried.entries) owed.set(entry.deploymentId, entry.seededAt);
    if (carried.entries.length > 0) {
      gapMs = carried.gapMs;
      log.event(
        "boot_downtime_flatten_owed",
        "engine",
        `boot: ${carried.entries.length} deployment(s) were still owed a downtime flatten by a ` +
          `previous boot after ${formatGapDuration(carried.gapMs)} with no engine activity — resuming that sweep ` +
          `regardless of this boot's verdict`,
      );
    }
  } catch (err) {
    log.event(
      "boot_obligation_unreadable",
      "engine",
      `boot: could not read the outstanding downtime-flatten set (a previously owed flatten may be lost): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (restart.flatten) {
    try {
      const activeIds = new Set(managed.filter((d) => d.status === "Active").map((d) => d.id));
      const fresh = [
        ...new Set(
          // `getAllOpenTrades()` is `status = 'open'` only, which is
          // deliberately *narrower* than the guard's own drain predicate
          // (`hasOpenTrade` → `pending_entry | open | pending_exit`). The
          // asymmetry is intentional: a `pending_entry` row is an entry the
          // broker has not confirmed, which is D-6's shortfall case — the
          // engine must not act on a position it cannot prove it holds, and
          // force-closing an unconfirmed entry can sell something that never
          // filled. The cost is real and bounded: an entry submitted seconds
          // before the crash that filled *during* the outage is not covered by
          // D-13's duration rule. It is not stranded — the reconciler promotes
          // it to `open` on the first tick and it is managed normally from
          // there — it simply does not get the boot-time flatten. Do not
          // widen this to match `hasOpenTrade` without first resolving what an
          // unconfirmed entry should do, which is a D-6 question, not this one.
          getAllOpenTrades()
            .map((t) => t.deploymentId)
            .filter((id) => activeIds.has(id)),
        ),
      ];
      // An id in both halves takes **this boot's** instant, never the carried
      // one. The fresh half is computed here from rows that are open *right
      // now*, so every one of them has `entry_submitted_at < nowMs` by
      // construction: `nowMs` refuses nothing currently open — all of it is
      // genuinely owed — while still refusing anything this process opens
      // after the seed, which is the only thing the instant exists to protect
      // against. The carried instant would refuse a position opened after it
      // and held across this boot's outage, under a log line saying it began
      // after the sweep was seeded, which for that row is false. A
      // carried-only id is not touched here and keeps its own instant, which
      // is where that protection actually lives.
      for (const id of fresh) owed.set(id, nowMs);
      gapMs = Math.max(gapMs, restart.gapMs ?? 0);
      if (fresh.length > 0) {
        log.event(
          "boot_downtime_flatten_owed",
          "engine",
          `boot: ${fresh.length} deployment(s) held a position across the gap in engine activity — ` +
            "force-flattening, then resuming with any signal standing before the stop discarded",
        );
      }
    } catch (err) {
      log.event(
        "boot_obligation_unreadable",
        "engine",
        `boot: could not read open trades for the downtime flatten (positions left open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (owed.size === 0) return { entries: [], gapMs: 0 };
  return {
    entries: [...owed].map(([deploymentId, seededAt]) => ({ deploymentId, seededAt })),
    gapMs,
  };
}

/**
 * The runtime half of `registry.test.ts`: say so when the registry this build
 * made is not `PROD_PLAYBOOK_KEYS`. Never refuses boot — a missing playbook
 * idles its book leg, and an extra one is already loaded; stopping the engine
 * over either takes the closing guard and the dashboard down with it.
 */
function reportProdPlaybookMismatch(): void {
  const mismatch = prodRegistryMismatch(registeredStrategyKeys(), !isStagingEnv());
  if (!mismatch) return;
  // The message is the alert's title (no template), so the consequence leads
  // and no file name is in it.
  const parts = [
    mismatch.missing.length > 0
      ? `Rows of ${mismatch.missing.join(", ")} take no entries: their playbooks are not in this build`
      : null,
    mismatch.unlisted.length > 0
      ? `Rows of ${mismatch.unlisted.join(", ")} can trade though their playbooks are not on the prod list`
      : null,
  ].filter((p): p is string => p != null);
  log.event(
    "boot_playbooks_mismatch",
    "engine",
    `${parts.join(". ")}. This build's playbooks are not the prod list — rebuild from a commit where the two agree.`,
  );
}

export async function runBootSequence(opts: BootOptions = {}): Promise<BootResult> {
  const timing = new BootTiming(opts.processMarks);
  let outcome: string = BOOT_THREW;
  try {
    const result = await bootSequence(opts, timing);
    outcome = result.kind;
    return result;
  } finally {
    timing.report(outcome);
  }
}

/** How often boot asks for a lease another process holds. */
export const LEASE_ACQUIRE_RETRY_MS = 1_000;
/** How long boot waits for it: past the freshness window, so a crashed
 *  holder's row has gone stale with room to spare. Still held after that is
 *  a live engine on this database. */
export const LEASE_ACQUIRE_BOUND_MS = LEASE_FRESH_MS + 5_000;

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Take the engine lease, waiting out a holder whose row has not gone stale
 * yet — the previous life of a crashed container, for up to
 * `LEASE_FRESH_MS`. Null when acquired; the refusal's reason otherwise.
 */
async function acquireEngineLease(): Promise<string | null> {
  const self = leaseHolderId();
  const started = Date.now();
  let warned = false;
  for (;;) {
    let blocker: string;
    try {
      const attempt = tryAcquireLease(self, Date.now());
      if (attempt.acquired) {
        log.event(
          "engine_lease_acquired",
          "engine",
          `boot: engine lease acquired by ${self}, generation ${attempt.generation}, ` +
            `after ${Date.now() - started}ms`,
        );
        return null;
      }
      blocker = describeLeaseHolder(attempt, Date.now());
    } catch (err) {
      blocker = `the lease row could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (Date.now() - started >= LEASE_ACQUIRE_BOUND_MS) {
      return (
        `another engine process holds the engine lease on this database and kept it for ` +
        `${LEASE_ACQUIRE_BOUND_MS / 1000}s — ${blocker}. Stop that process before starting this one.`
      );
    }
    if (!warned) {
      warned = true;
      log.event(
        "engine_lease_waiting",
        "engine",
        `boot: waiting for the engine lease — ${blocker}. A crashed holder's lease goes stale within ` +
          `${LEASE_FRESH_MS / 1000}s; boot refuses after ${LEASE_ACQUIRE_BOUND_MS / 1000}s.`,
      );
    }
    await sleep(LEASE_ACQUIRE_RETRY_MS);
  }
}

/**
 * Take the lease and keep it renewed, or refuse as a boot assertion so
 * `maybeAutoStart` answers 503. Null when held; the refusal's reason
 * otherwise. Boot's first step, and `instrumentation.ts`'s on an install with
 * no broker configured: that process never boots until the wizard, yet its
 * routes reach `getEngine()`, which builds nothing without the lease.
 */
export async function takeEngineLease(): Promise<string | null> {
  const refusal = await acquireEngineLease();
  if (refusal) {
    markBootAssertionFailed(refusal);
    reportLeaseRefused("boot", refusal);
    return refusal;
  }
  startLeaseRenewal({ onLost: () => getEngineIfReady()?.stop() });
  return null;
}

/** How long a standby waits for the active engine to accept its request. */
export const HANDOFF_WAIT_MS = 60_000;
/** How often a standby looks at the lease while it waits. */
export const HANDOFF_POLL_MS = 1_000;
/**
 * How long a standby waits after the active accepted: its drain is capped at
 * `SHUTDOWN_EXIT_CAP_MS`, and an active that dies mid-drain leaves a lease
 * that goes stale `LEASE_FRESH_MS` after its last renew. Past both, the
 * active is alive, draining with entries refused, and not exiting.
 */
export const HANDOFF_YIELD_BOUND_MS = SHUTDOWN_EXIT_CAP_MS + LEASE_FRESH_MS;

type HandoffOutcome = { taken: true; generation: number; waitedMs: number } | { taken: false; refusal: string };

let askingForHandoff = false;
let handoffWithdrawHookInstalled = false;

/**
 * A standby stopped while it waits — the deploy rolling back — withdraws its
 * request on the way out, so the active never yields to a process that is
 * leaving. A request it can no longer withdraw was accepted, and the deploy's
 * rollback restarts the old container (infra/README, *Hand-off deploys*);
 * one left by a standby killed outright is accepted only inside
 * `HANDOFF_REQUEST_FRESH_MS` of its last refresh. The poll refuses to take
 * the engine once the stop has started (`isShutdownStarted`), and the
 * draining latch goes up here too: from the take until the marker hook is
 * installed at classification, it is the only thing that refuses entries.
 */
function withdrawHandoffOnStop(): void {
  askingForHandoff = true;
  if (handoffWithdrawHookInstalled) return;
  handoffWithdrawHookInstalled = true;
  registerPreCloseHook(() => {
    markShutdownDraining();
    if (!askingForHandoff) return;
    askingForHandoff = false;
    try {
      withdrawHandoff(leaseHolderId());
    } catch {
      // Left in the row, it goes stale in LEASE_FRESH_MS and is never accepted.
    }
  });
}

/**
 * The standby's half of the hand-off: take the lease if it is free or stale
 * — no active, or a crashed one — or else ask the active for it and wait.
 * **It never takes a fresh lease**: `tryAcquireLease` refuses one, and the
 * request is the only thing a standby writes on a lease another process
 * holds. Past `HANDOFF_WAIT_MS` with no acceptance it withdraws the request —
 * atomically against the active's accept, so the two can never both lose —
 * and refuses; the active keeps trading.
 */
async function awaitHandoff(): Promise<HandoffOutcome> {
  withdrawHandoffOnStop();
  try {
    return await pollForHandoff();
  } finally {
    askingForHandoff = false;
  }
}

const STOPPING_REFUSAL =
  "this standby was stopped while it waited, so it does not take the engine on its way out.";

async function pollForHandoff(): Promise<HandoffOutcome> {
  const self = leaseHolderId();
  const started = Date.now();
  let askedOf: string | null = null;
  let acceptedAt: number | null = null;
  // Another standby whose request stood when this one asked. A holder that
  // is that standby took the engine; asking it would hand it straight back.
  let queuedBehind: string | null = null;
  for (;;) {
    const now = Date.now();
    let blocker = "the lease row could not be read";
    try {
      const attempt = tryAcquireLease(self, now);
      // After the take, not only before it: a stop that started while this
      // process waited must not leave it holding the engine on its way out.
      if (isShutdownStarted()) {
        if (attempt.acquired) releaseLease(self);
        return { taken: false, refusal: STOPPING_REFUSAL };
      }
      if (attempt.acquired) return { taken: true, generation: attempt.generation, waitedMs: now - started };
      blocker = describeLeaseHolder(attempt, now);
      if (acceptedAt != null || (queuedBehind != null && attempt.holder === queuedBehind)) {
        if (attempt.holder !== askedOf) {
          return {
            taken: false,
            refusal: `another process took the engine — ${blocker}. This standby stays inert and does not ask it back.`,
          };
        }
      } else if (attempt.holder !== askedOf) {
        const ask = requestHandoff(self, now);
        if (ask.kind === "requested") {
          askedOf = ask.holder;
          log.event(
            "handoff_requested",
            "engine",
            `handoff: requested — standby ${self} asked ${ask.holder} (generation ${ask.generation}) for the engine; ` +
              `it waits up to ${HANDOFF_WAIT_MS / 1000}s for the active to drain and release`,
          );
        } else if (ask.kind === "queued" && ask.behind !== queuedBehind) {
          queuedBehind = ask.behind;
          log.event(
            "handoff_queued",
            "engine",
            `handoff: queued — standby ${ask.behind} has already asked ${ask.holder} for the engine; ` +
              `standby ${self} waits for that request to clear before it asks`,
          );
        }
      } else if (askedOf != null && !refreshHandoffRequest(self, now)) {
        if (handoffAcceptedBy(askedOf)) acceptedAt = now;
        // Otherwise lapsed and asked over: ask again, or queue, next look.
        else askedOf = null;
      }
    } catch (err) {
      blocker = `the lease row could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (acceptedAt == null && now - started >= HANDOFF_WAIT_MS) {
      let accepted = false;
      try {
        accepted = !withdrawHandoff(self) && askedOf != null && handoffAcceptedBy(askedOf);
      } catch {
        // Unreadable: refuse. An active that did accept still exits, and its
        // lease is then free for the next deploy.
      }
      if (!accepted) {
        return {
          taken: false,
          refusal:
            `the active engine did not accept the hand-off in ${HANDOFF_WAIT_MS / 1000}s — ${blocker}. ` +
            "It is still trading; this standby stays inert.",
        };
      }
      // Accepted between the last look and the withdraw: it is yielding.
      acceptedAt = now;
    }
    if (acceptedAt != null && now - acceptedAt >= HANDOFF_YIELD_BOUND_MS) {
      return {
        taken: false,
        refusal:
          `the active engine accepted the hand-off but has not released the lease ${HANDOFF_YIELD_BOUND_MS / 1000}s later — ` +
          `${blocker}. It is draining with new entries refused; stop it, and this standby stays inert.`,
      };
    }
    await sleep(HANDOFF_POLL_MS);
  }
}

/**
 * A standby engine process's boot (`CROSSFIRE_STANDBY=1`, engine-boot.md,
 * *Hand-off*): process boot while another process runs the engine, then the
 * hand-off, then — holding the lease — the same classification and activation
 * the ordinary boot runs. Hubs are cold: they connect in `activateEngine`,
 * after the old engine has exited.
 */
export async function runStandbyBoot(opts: BootOptions = {}): Promise<BootResult> {
  const timing = new BootTiming(opts.processMarks);
  let outcome: string = BOOT_THREW;
  try {
    const result = await standbySequence(opts, timing);
    outcome = result.kind;
    return result;
  } finally {
    timing.report(outcome);
  }
}

async function standbySequence(opts: BootOptions, timing: BootTiming): Promise<BootResult> {
  if (!runsEngine()) throw new EngineNotInThisProcessError("standby boot");
  // The running engine's Topstep session is the one cached token: until this
  // process holds the lease it reads that token and never refreshes it.
  holdTokenRefresh(true);
  const boot = await prepareEngineProcess(opts, timing, STANDBY_ARMS);
  if (boot.refused) return boot.refused;
  await connectHubsWhileStandby();
  log.event(
    "standby_ready",
    "engine",
    `handoff: standby ready — ${leaseHolderId()} has booted beside the running engine and asks for it next`,
  );

  const handoff = await awaitHandoff();
  if (!handoff.taken) {
    markBootAssertionFailed(handoff.refusal);
    log.event("handoff_refused", "engine", `handoff: refused — ${handoff.refusal}`);
    return { kind: "error", message: handoff.refusal };
  }
  holdTokenRefresh(false);
  startLeaseRenewal({ onLost: () => getEngineIfReady()?.stop() });
  timing.mark("leaseAcquired");

  // Classified here, at takeover, never at the standby's own boot: until now
  // the old engine was stamping the heartbeat, and a classification taken
  // then reads a running engine as a crash. The heartbeat it reads now is the
  // yielded engine's last stamp, so the gap is real.
  const restart = await classifyStage(timing);
  // Ahead of `handoff_taken`, so a staging refusal here is a boot failure the
  // deploy's poll sees before it reads the take as a success.
  const heldRefusal = await askHeldBackArms(opts, boot.fanOut);
  timing.mark("heldBackArmsAsked");
  if (heldRefusal) return heldRefusal;
  log.event(
    "handoff_taken",
    "engine",
    `handoff: taken — ${leaseHolderId()} holds the engine lease at generation ${handoff.generation}, ` +
      `${handoff.waitedMs}ms after it asked; ` +
      (restart.gapMs == null
        ? "no previous engine heartbeat on this database."
        : `${formatGapDuration(restart.gapMs)} since the previous engine's last heartbeat.`),
  );
  return activateEngine(restart, timing);
}

/**
 * The seam for warm hubs. Cold for now: Topstep kicks a second SignalR
 * session on one user, so whether a standby's hubs can sit beside the active
 * engine's on the shared token is a staging test, not a design choice. Until
 * that test says so, nothing connects here and `activateEngine` opens the
 * hubs after the old engine has exited.
 */
async function connectHubsWhileStandby(): Promise<void> {}

async function bootSequence(opts: BootOptions, timing: BootTiming): Promise<BootResult> {
  // A web process never boots an engine; it reaches this only by a wiring
  // mistake, and must not consume the marker or stamp the heartbeat on the
  // way to failing.
  if (!runsEngine()) throw new EngineNotInThisProcessError("boot");

  // The lease before anything else: the classification below consumes the
  // marker and starts the heartbeat, and both belong to whichever process
  // runs the engine.
  const leaseRefusal = await takeEngineLease();
  if (leaseRefusal) return { kind: "error", message: leaseRefusal };
  timing.mark("leaseAcquired");

  const restart = await classifyStage(timing);
  const { refused } = await prepareEngineProcess(opts, timing);
  if (refused) return refused;
  return activateEngine(restart, timing);
}

/**
 * D-13's two signals, read and re-armed before anything can return early.
 * See `classifyBoot` for why the position of this call matters: first thing
 * after the lease, on both doors — at boot, and at a standby's takeover.
 */
async function classifyStage(timing: BootTiming): Promise<RestartVerdict> {
  const classifiesHere = bootVerdict == null;
  const restart = await classifyBoot();
  timing.mark("restartClassified");
  // Only the pass that consumed the marker reports the gap: the memoised
  // verdict a second pass reads carries the same instant, and the stop it
  // measured was not this pass's.
  if (classifiesHere && restart.cleanShutdownAt != null) {
    timing.previousShutdownAt(restart.cleanShutdownAt);
  }
  return restart;
}

/**
 * Process boot: what a process needs before it can run an engine and that
 * touches nothing a running engine on this database is managing — the
 * order-map TTL sweep (terminal rows only), the account fan-out and its
 * `account_brokers` upsert, and the staging allowlist. **A standby runs this
 * while another process holds the lease**, which is why everything that
 * writes a row an engine trades (the session migration, the books, the
 * orphan check) is in `activateEngine` and not here. `refused` is null to go
 * on, or the staging refusal the wizard surfaces; `fanOut` is what a standby
 * completes at takeover (`askHeldBackArms`).
 */
async function prepareEngineProcess(
  opts: BootOptions,
  timing: BootTiming,
  ask: FanOutArms = EVERY_ARM,
): Promise<{ refused: BootResult | null; fanOut: BrokerAccountFanOut }> {
  // Drop terminal Tradovate order-map rows older than the TTL. Best-
  // effort — a sqlite hiccup here doesn't block boot. Live (non-
  // terminal) rows are preserved regardless of age.
  try {
    cleanupExpiredOrderMappings();
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: tradovate_order_map TTL cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // One account fan-out, three consumers. It runs on every boot, in both
  // environments, because seeding `account_brokers` is not optional: the
  // table is the persisted projection of the runtime registry, only the
  // engine's `refresh()` used to write it, and the session-migration
  // pre-flight below reads it *before* the engine exists. On a
  // Tradovate-configured install a never-refreshed table blocks migration
  // outright (`resolveBrokerKind` treats untagged-with-Tradovate-present
  // as unknown, and unknown fails closed); on any install it routes every
  // untagged account to Topstep. Seeding here closes both.
  //
  // The seed also carries each account's name and practice flag, which is
  // what lets the live-account auto-trade block classify a deployment from
  // its `accountId` without a broker round-trip on the deploy path. It runs
  // ahead of every `listManagedDeployments()` call below for that reason:
  // an unseeded account is unclassifiable, and unclassifiable is refused.
  const fanOut = await fanOutBrokerAccounts(ask);
  seedAccountBrokers(fanOut);
  timing.mark("accountsFannedOut");
  return { refused: checkFanOut(fanOut, opts), fanOut };
}

/**
 * The arms a standby's boot held back (`STANDBY_ARMS`), asked once it holds
 * the engine and before `activateEngine` builds anything — so this is the
 * standby's one Tradovate login, and `getEngine()`'s `initialize()` finds the
 * token fresh. Seeds what they return; the staging checks then judge the
 * whole fan-out, boot's half included.
 */
async function askHeldBackArms(opts: BootOptions, boot: BrokerAccountFanOut): Promise<BootResult | null> {
  if (boot.heldBack.length === 0) return null;
  const held = await fanOutBrokerAccounts({
    topstep: boot.heldBack.includes(BrokerKind.Topstep),
    tradovate: boot.heldBack.includes(BrokerKind.Tradovate),
  });
  seedAccountBrokers(held);
  return checkFanOut(
    {
      accounts: [...boot.accounts, ...held.accounts],
      attempted: boot.attempted + held.attempted,
      // Boot's own failures were already refused (staging) or reported (prod).
      failures: held.failures,
      heldBack: [],
    },
    opts,
  );
}

function seedAccountBrokers(fanOut: BrokerAccountFanOut): void {
  try {
    // Upsert, never a delete-and-replace: a broker whose arm failed must
    // keep the tags it already had rather than lose them to an outage.
    setAccountBrokers(toAccountBrokerSeeds(fanOut.accounts));
    log.event(
      "boot_accounts_seeded",
      "engine",
      `boot: seeded account_brokers with ${fanOut.accounts.length} account(s) from ` +
        `${fanOut.attempted} configured broker(s)`,
    );
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: account_brokers seeding failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The fan-out's failure report (prod) and the staging allowlist with its two
 *  refusals. Null to go on. */
function checkFanOut(fanOut: BrokerAccountFanOut, opts: BootOptions): BootResult | null {
  // A failed arm on prod is not fatal — the previous boot's names survive
  // the upsert, so an install that has ever seeded keeps trading. On a
  // first boot after the migration, or any install that never seeded, those
  // accounts stay nameless and every deployment on them is withheld, and
  // the only other trace is one warn per row from `listManagedDeployments`.
  // Staging refuses to start on the same condition below; prod says so at
  // error level and carries on. Nothing else reads `fanOut.failures` here.
  if (!isStagingEnv() && fanOut.failures.length > 0) {
    log.event(
      "boot_fanout_failed",
      "engine",
      `boot: broker account fan-out failed — ${fanOut.failures.join(" | ")}. ` +
        "Accounts on those brokers may be unclassifiable, and deployments on them " +
        "are withheld from the engine until a later boot seeds their names.",
    );
  }

  // Staging-only allowlist derivation. Two independent fatal conditions,
  // and the count is only one of them — a staging engine that boots
  // without a complete PRAC filter would silently fire every enabled
  // deployment it does not know to exclude. The wizard wants both
  // surfaced synchronously so the operator sees the reason instead of a
  // 10s polling timeout.
  //
  // `isPracticeAccount` is broker-agnostic: it reads the server-computed
  // `practice` flag stamped at each broker's translator (Topstep = PRAC-
  // name prefix, Tradovate = demo host). Tradovate-live accounts
  // therefore never reach the allowlist; only Tradovate demo accounts do.
  if (isStagingEnv()) {
    // Any arm failure refuses to start, independent of the resulting
    // count. A partial allowlist is *safe* — every id in it came back
    // from a broker and passed `isPracticeAccount`, so a lost arm can
    // only make the filter more restrictive — but it is not *honest*:
    // on a mixed install a thrown Topstep arm plus one Tradovate demo
    // account yields a non-empty allowlist and boots with every Topstep
    // deployment silently filtered out. This was a hard refuse-to-start
    // before the fan-out was shared; keep it one.
    const failure =
      fanOut.failures.length > 0
        ? `staging boot: broker account fan-out failed — ${fanOut.failures.join(" | ")}`
        : null;
    const allowedIds = failure
      ? []
      : fanOut.accounts.filter(isPracticeAccount).map((a) => a.id);
    // A fan-out that held a broker back has not heard every broker, so an
    // empty count is not yet an answer and its allowlist would be partial;
    // the takeover's pass derives both over the whole fan-out. A failed arm
    // still refuses here, before the standby asks for the engine.
    const complete = fanOut.heldBack.length === 0;
    const reason =
      failure ??
      (complete && allowedIds.length === 0
        ? "staging boot: no PRAC accounts found in /Account/search"
        : null);
    if (reason) {
      markBootAssertionFailed(reason);
      log.event("boot_refused", "engine", `boot: ${reason} — refusing to start`);
      if (opts.rethrowAllowlistFailure) {
        return { kind: "staging-allowlist-empty", message: reason };
      }
      throw new Error(reason);
    }
    if (!complete) return null;
    setStagingAllowlist(allowedIds);
    markBootAssertionPassed();
    log.event(
      "boot_staging_allowlist",
      "engine",
      `boot: staging allowlist derived — ${allowedIds.length} practice account(s) across ` +
        `all ${fanOut.attempted} configured broker(s)`,
    );
  }
  return null;
}

/**
 * Engine activation: everything from the session migration to `start()`, run
 * by the process that holds the lease and has classified the restart. Its
 * order is the boot's, unchanged; the paragraphs in engine-boot.md that pin
 * it (the books reconcile before the first deployment read, the realtime
 * pre-flight after the hubs) all live inside this one function.
 */
async function activateEngine(restart: RestartVerdict, timing: BootTiming): Promise<BootResult> {
  // Pending-session-migration pre-flight. Consults broker state to
  // skip rows holding open positions; clean rows go to
  // `enabled=0 + pending_reconciliation`.
  {
    // Topstep configured but unreachable defers the whole migration, as
    // it always has — a Topstep outage must not migrate Topstep rows as
    // clean. Topstep *not configured* is a different answer: there are no
    // Topstep rows to check, so migration proceeds and the lookup throws
    // per-account for anything that does route to Topstep.
    const topstepConfigured =
      (brokerRegistry.getPlugin("topstep") as TopstepBrokerPlugin | null)?.isConfigured() === true;
    let client: TopstepClient | null = null;
    let topstepUnavailable = false;
    if (topstepConfigured) {
      try {
        client = await getTopstepClientFromPlugin();
      } catch (err) {
        topstepUnavailable = true;
        log.event(
          "session_migration_deferred",
          "engine",
          `boot: Topstep client unavailable for session-migration broker check — ` +
            `migration deferred to next boot: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!topstepUnavailable) {
      // Per-account routing: checking a Tradovate deployment against
      // Topstep answered "flat" and migrated it as clean. The lookup also
      // lets the broker error propagate on purpose —
      // `runPendingSessionMigrations` reads a throwing `hasOpenPosition`
      // as "in position" and leaves the row intact, which the old
      // `catch { positions = [] }` defeated.
      const positionsFor = createBootOpenPositionLookup(client);
      const { migrated, blocked } = await runPendingSessionMigrations({
        hasOpenPosition: (d) => hasOpenPositionOnBroker(positionsFor, d),
      });
      if (migrated.length > 0) {
        log.event(
          "session_migration_done",
          "engine",
          `boot: session-migration migrated ${migrated.length} clean row(s) ` +
            `(disabled + pending_reconciliation)`,
        );
      }
      setMigrationBlocked(blocked.map((d) => d.id));
      if (blocked.length > 0) {
        log.event(
          "session_migration_blocked",
          "engine",
          // Not "hold open positions": a leg is also blocked when a *sibling*
          // leg holds one, because the session config the migration rewrites
          // is shared. The line reports what was checked, not what the
          // majority case assumes.
          `boot: ${blocked.length} deployment(s) could not be migrated — an open position on ` +
            `the row or on another account of the same deployment. Close those positions, ` +
            `then restart the engine to complete migration.`,
        );
      }
    }
  }

  // Construct the engine + open hubs BEFORE the deployment-empty branch.
  // The hub init has to happen on every successful auth, deployments or
  // not — the dashboard's account/positions/orders panels depend on
  // user-hub fan-out (via the SSE route) and a first-render against an
  // unbuilt hub surfaces as "Auth failed" until the next refresh. Only
  // the per-tick deployment loop stays gated on enabled count below.
  const eng = await getEngine();
  // The books migrations' reports (merges, books in code), held until now:
  // `getEngine()` has started the log store, so the lines reach `engine_logs`
  // rather than stdout alone, and this runs ahead of every early return below.
  reportBookMigrations();
  reportProdPlaybookMismatch();
  const hubs = await eng.ensureHubsReady();
  timing.mark("hubsReady");

  // Realtime-slot pre-flight. `realtime()` throws when the persisted
  // selection is unregistered or has lost `liveBars`, and every engine bar
  // read goes through it — a running engine would log one error per
  // deployment per tick, never evaluate another bar, and never fire a
  // strategy exit, visible only in /logs. Resolve it once here so the
  // failure is a refuse-to-start with a message naming the id instead.
  // Runs after the staging block so `markBootAssertionPassed()` cannot
  // clobber the failure, and after `ensureHubsReady()` so a bad selection
  // still leaves the dashboard's account panels working.
  try {
    marketDataRegistry.realtime();
  } catch (err) {
    const selectedId = marketDataRegistry.slotProviderId("realtime") ?? "(none)";
    const reason =
      `realtime market-data provider "${selectedId}" is unusable: ` +
      `${err instanceof Error ? err.message : String(err)} ` +
      "Re-select a live-capable provider in Settings, then start the engine.";
    markBootAssertionFailed(reason);
    log.event("boot_refused", "engine", `boot: ${reason} — refusing to start`);
    return { kind: "error", message: reason };
  }
  timing.mark("realtimePreflightPassed");

  // Materialise the books before the first read of the deployment set, so a
  // row a book asked for joins this boot rather than the next one. It sits
  // below the account fan-out because the live-account screen it runs needs a
  // name in `account_brokers`, and below the realtime pre-flight because a
  // boot that refuses to start should not have written anything.
  //
  // `resumed` is empty: a plan is computed from transitions, so a boot never
  // re-arms a row the operator paused by hand. `inPosition` is the durable
  // trade row alone — the engine holds no state for these rows yet and the
  // broker arm is async, and the trade row is the load-bearing clause of
  // `holdsPosition` anyway.
  try {
    runBookReconcile({ inPosition: (leg) => getOpenTradeForDeployment(leg.id) != null });
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: book reconcile failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  timing.mark("booksReconciled");

  // Once per database, after the reconcile so a cell re-added this boot is
  // resumed above rather than retired here (books/retire-off-cell-rows.ts).
  try {
    runRetireOffCellRows();
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: retiring off-cell derived rows failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const enabledRead = readManagedDeployments();
  const enabled = enabledRead.deployments;
  if (enabled.length === 0) {
    // Two different boots end up here and they need different answers.
    // "Nothing is enabled" is the operator's own doing; "everything
    // enabled was withheld" is the engine coming up idle on an install
    // that was trading yesterday — usually a fan-out arm that threw above,
    // leaving those accounts unclassifiable.
    const withheld = enabledRead.withheldLiveAccounts;
    if (withheld.length > 0) {
      log.event(
        "boot_all_withheld",
        "engine",
        `boot: ${withheld.length} enabled deployment(s) withheld — engine idle. ` +
          `${withheld[0].reason}`,
      );
    }
    // The staging allowlist is the other filter that can empty the list,
    // and it produces the same silent idle: the operator sees the same
    // "no enabled deployments" line whether they enabled nothing or the
    // allowlist dropped everything. Name the accounts — on staging the
    // fix is almost always "that account is not a PRAC account", which
    // only the ids make actionable.
    const skipped = enabledRead.skippedNotAllowed;
    if (skipped.length > 0) {
      const accountIds = Array.from(new Set(skipped.map((s) => s.accountId)));
      log.event(
        "boot_all_withheld",
        "engine",
        `boot: ${skipped.length} enabled deployment(s) withheld — engine idle. ` +
          `None of their accounts are in the staging allowlist: ${accountIds.join(", ")}. ` +
          "The allowlist holds only practice accounts returned by the boot fan-out.",
      );
    }
    // Both filters are reported before returning, and the count sums them.
    // Returning on the first meant a staging boot that live-blocked three
    // rows and allowlist-dropped seven reported three, said nothing about
    // the seven, and left the operator fixing one cause, restarting, and
    // finding themselves still idle.
    const withheldCount = withheld.length + skipped.length;
    if (withheldCount > 0) return { kind: "all-withheld", withheldCount };

    // A56. `(hubs ready)` was a fixed string on a path that consulted no hub
    // state, and it printed on a boot where both hubs had just failed to
    // construct — so the loudest line on a container with no market data and
    // no account events said everything was fine. This one renders what
    // `ensureHubsReady` returned, and a feed that did not come up makes the
    // line a `warn`.
    const feeds = describeHubReadiness(hubs);
    const line = `boot: no enabled deployments — engine idle. ${feeds.text}`;
    // Two events, not one with a variable severity: an idle engine whose
    // feeds are up and an idle engine that came up blind are different
    // states, and A56 is what happens when one line is asked to be both.
    if (feeds.healthy) log.event("boot_idle", "engine", line);
    else log.event("boot_idle_feed_down", "engine", line);
    return { kind: "no-deployments" };
  }

  // A detached row is in the set on purpose — it exits, it never enters (the
  // entry gate, A75). Said here once per row per boot, because the gate's own
  // line waits for the row to be flat and asked to enter, and a row holding a
  // position would otherwise run the whole session unannounced.
  for (const d of enabled) {
    if (d.orphanReason == null) continue;
    log.event(
      "deployment_withheld",
      "engine",
      `boot: deployment ${d.id} is detached (${d.orphanReason}) — exits only, no new entries until ` +
        "Restore and arm clears it",
      { deploymentId: d.id, accountId: d.accountId },
    );
  }

  // Broker-registry refresh + orphan-account cross-check. The registry
  // fan-out hits every configured broker (Topstep + optional Tradovate);
  // orphan detection then runs against the merged account set so a
  // Tradovate-only deployment doesn't get miscategorized as orphaned
  // when only Topstep is configured.
  //
  // A cold boot has nothing to carry forward, so a single `searchAccounts`
  // throw leaves that broker's whole catalog absent from the map. Reading
  // that silence as "the account is gone" is A74 — it orphan-paused both
  // legs of a live combine for two trading days, permanently, because
  // orphaning is one-way. The skip is fail-open **on purpose**: orphan-pause
  // is not the live-account safety gate (`autoTradeVerdict` is, and it is
  // untouched here), and the worst case of skipping the cross-check is one
  // rejected order, which orphans as `place_order_account_not_found` — a
  // broker's answer rather than an inference from a fan-out's silence.
  try {
    const refresh = await eng.refreshBrokerRegistry();
    const absentAccountIds = new Set<number>();
    for (const d of enabled) {
      if (!eng.isAccountRegistered(d.accountId)) absentAccountIds.add(d.accountId);
    }
    // Absent from the registry is only evidence when the arm that owns the
    // account answered. Attributed per account rather than per fan-out: a
    // Tradovate outage must not stop genuine Topstep orphan detection.
    const orphanedAccountIds = new Set<number>();
    for (const acctId of absentAccountIds) {
      const verdict = attributeAbsentAccount(getAccountBrokerOrNull(acctId), refresh);
      if (verdict.decision === "skip") {
        log.event(
          "orphan_check_skipped",
          "engine",
          `boot: orphan check skipped for account ${acctId} — ${verdict.reason}.`,
          { accountId: acctId },
        );
        continue;
      }
      orphanedAccountIds.add(acctId);
    }
    for (const acctId of orphanedAccountIds) {
      await eng.handleOrphanedAccount(acctId, "account_unavailable_at_boot");
    }
  } catch (err) {
    log.event(
      "boot_step_failed",
      "engine",
      `boot: broker registry refresh / orphan check failed (continuing anyway): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stillEnabled = listManagedDeployments();
  if (stillEnabled.length === 0) {
    log.event("boot_idle", "engine", "boot: all enabled deployments orphaned — engine left idle");
    return { kind: "no-enabled-after-orphan-check" };
  }
  if (eng.isRunning()) {
    return { kind: "already-running" };
  }

  // D-13's flatten set and D-14's resume, handed over before `start()`: the
  // suppression latch has to be in place before the priming tick can evaluate
  // anything, and `start()` is what arms the sweep.
  //
  // **The latch lives on the engine, and it is the only one.** Memoising the
  // verdict is not enough on its own, because the candidate set is not
  // memoised with it: `runBootSequence` has two callers and
  // `activateFromSettings` is reachable from `POST /api/settings/setup` at any
  // time, including after the out-of-band key rotation that route exists to
  // catch. `if (eng.isRunning()) return` is the only other guard and
  // `isRunning()` is false after either fatal-auth `stop()`. Without it a
  // 09:00 boot's `flatten` verdict meets `getAllOpenTrades()` as it stands at
  // 14:30 and force-closes a position opened at 14:15, logging "went unmanaged
  // for 4h" about thirty seconds of it. It is on the engine rather than in
  // this module because `start()` is the other door onto the same obligation
  // and a second flag would drift from this one.
  if (!eng.hasAppliedRestartVerdict()) {
    eng.applyRestartVerdict(restart, collectOwedFlatten(restart, stillEnabled));
  }

  eng.start(stillEnabled);
  timing.mark("engineStarted");
  log.event(
    "boot_started",
    "engine",
    `boot: auto-started with ${stillEnabled.length} enabled deployment(s)`,
  );
  return { kind: "started", deploymentCount: stillEnabled.length };
}
