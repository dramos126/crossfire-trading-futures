import { getDb, registerMigration } from "./connection";
import type {
  Deployment,
  DeploymentStatus,
  OperatorDeploymentStatus,
  TickerSymbol,
} from "@/lib/trading/domain";
import { isClosingStatus, parseDeploymentStatus } from "@/lib/trading/domain";
import { isInBlackoutRange, mainSessionsOverlap, snapOutOfBlackout } from "@/lib/trading/session/session";
import { getStrategy, sessionForStrategyKey } from "@/lib/trading/strategies";
import { RENAMED_KEYS } from "@/lib/trading/strategies/renamed-keys";
import { getStagingAllowlist } from "@/lib/trading/broker-access/staging-allowlist";
import { autoTradeVerdictsForAccountIds } from "./account-brokers";
import { autoTradeVerdict } from "@/lib/trading/broker-access/account-trading-policy";
import type { MainSession, PauseWindow } from "@/lib/trading/strategy-types";
import { log } from "@/lib/logger";

registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      strategy_key TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      contract_id TEXT,
      enabled INTEGER NOT NULL,
      param_values TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_account ON deployments(account_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_enabled ON deployments(enabled);
  `);

  // Orphan tracking. orphan_reason set means the deployment was auto-paused
  // because its account is no longer accessible (combine→XFA upgrade,
  // expired sim, etc). orphaned_at is when we detected it; the deployments
  // page renders these in a dedicated top-of-page section with a "recreate
  // to a different account" affordance. Idempotent column-add for existing
  // databases — SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN.
  const addColumn = (col: string, type: string) => {
    try { d.exec(`ALTER TABLE deployments ADD COLUMN ${col} ${type}`); } catch { /* exists */ }
  };
  addColumn("orphaned_at", "TEXT");
  addColumn("orphan_reason", "TEXT");

  // Soft-delete. deleted_at being non-null moves the row to the Trash
  // tab; the row stays so trades remain attached to a real deployment_id
  // and the user can Recreate to a (potentially different) account.
  addColumn("deleted_at", "TEXT");

  // Tombstone marker. Trash-tab "Retire" sets this instead of
  // hard-deleting the row, so strategy_trades rows keep a valid foreign
  // key for attribution. Engine never reads tombstoned rows: active
  // queries (listDeployments / listManagedDeployments) already filter
  // `deleted_at IS NULL`, and Retire writes both `tombstoned_at` and
  // `deleted_at`. Bucket-classification SQL in src/lib/db/trades.ts
  // feature-detects this column on first use, so pre-existing DBs pick
  // it up on the next process boot.
  addColumn("tombstoned_at", "TEXT");

  // Optional human label for a deployment. Null falls back to the
  // strategy's display name in the UI; explicit values disambiguate
  // copies (e.g. "ORB — NY" vs "ORB — Overnight").
  addColumn("name", "TEXT");

  // Monotonic edit counter. Increments on every successful PATCH (see
  // updateDeployment). Stamped onto every trade row at entry so the
  // analytics panel can flag trades fired against a since-edited config
  // as "from a prior deployment version." Backfill default = 1 covers
  // existing rows.
  addColumn("version", "INTEGER NOT NULL DEFAULT 1");

  // Per-row pending-reconciliation reason. Set by the session migration
  // runner when a row's old `additionalSessions` shape can't be
  // auto-projected into the new `mainSession + pauseWindows` model
  // (extras are disjoint, not nested). Cleared on the user's first
  // session-config-touching save. Top-level column (not nested in JSON)
  // so the banner-count query is a trivial indexed scan.
  addColumn("pending_reconciliation", "TEXT");

  // The leg's three columns.
  //   group_id        — the parent this leg belongs to. Never null on a row
  //                     this build writes; a NULL predates *one deployment,
  //                     N legs* and is reported by the guard at the bottom
  //                     of this file. The parent owns the canonical config
  //                     (params, filters, ticker, contract).
  //   size_override   — **dead since the risk sizer landed.**
  //                     It was the per-leg contract count and the only thing
  //                     ever genuinely per leg; contract count is now the
  //                     risk sizer's answer from the account's posture, so
  //                     nothing reads it and no INSERT or UPDATE writes it.
  //                     The ALTER stays so an existing database and a fresh
  //                     one have the same shape — the column is nullable, so
  //                     leaving it costs nothing, and `DROP COLUMN` is
  //                     irreversible. Do not add a reader.
  //   enabled_snapshot — written at parent-disable time (or on manual leg
  //                     edits during a disabled window, or at insert under a
  //                     disabled parent) so re-enable restores the intended
  //                     per-leg state.
  addColumn("group_id", "TEXT");
  addColumn("size_override", "INTEGER");
  addColumn("enabled_snapshot", "INTEGER");
  // Cheap by-group query (engine sync, group-edit fan-out, panic-pause).
  // Without this, every group operation full-scans deployments.
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_deployments_group_id ON deployments(group_id)`); } catch { /* exists */ }

  // 2026-04-27: HH:MM time params can no longer land inside the
  // session-boundary blackout (15:55–18:05 ET) — Topstep system-cancels
  // brackets across the close, so we exit before that and stay out
  // until the reopen settles. Snap any stored value inside a blackout
  // range to its nearest valid edge (16:00 → 15:55, 18:00 → 18:05).
  // Done generically over every "HH:MM"-shaped string in paramValues so
  // strategy-specific time fields (orb-overnight rangeStartEt, etc.)
  // get fixed too without enumerating each one here.
  //
  // Note: legacy CommonParam BE/trail keys (breakEvenEnabled etc.) are
  // translated at param-load time via `migrateLegacyParamOverrides` —
  // not on this DB-migration pass. Step 4 of the exit-filter registry
  // refactor removed those keys from the schema; the shim is the only
  // adaptation layer for stored deployments.
  type ParamsRow = { id: string; param_values: string };
  const rows = d
    .prepare("SELECT id, param_values FROM deployments")
    .all() as ParamsRow[];
  const update = d.prepare("UPDATE deployments SET param_values = ? WHERE id = ?");
  const tx = d.transaction((items: ParamsRow[]) => {
    for (const r of items) {
      let pv: Record<string, unknown>;
      try {
        pv = JSON.parse(r.param_values);
      } catch {
        continue;
      }
      let dirty = false;
      const HHMM = /^\d{1,2}:\d{2}$/;
      for (const [k, v] of Object.entries(pv)) {
        if (typeof v !== "string" || !HHMM.test(v)) continue;
        if (!isInBlackoutRange(v)) continue;
        const snapped = snapOutOfBlackout(v);
        if (snapped !== v) {
          pv[k] = snapped;
          dirty = true;
        }
      }
      if (dirty) update.run(JSON.stringify(pv), r.id);
    }
  });
  tx(rows);
});

// 2026-08-24 P3: the Active / Pausing / Paused / Destroying status column.
//
// Replaces `enabled` as the lifecycle field. The column is added **nullable
// with no default** and backfilled explicitly, because `NOT NULL DEFAULT
// 'Active'` would arm every disabled row in the table the instant the ALTER
// ran — the single worst outcome this migration can produce. A row that
// somehow escapes the backfill reads as `Paused` (see
// `parseDeploymentStatus`), so every direction of failure lands on "not
// managed".
//
// The mapping, and why each row goes where it does:
//
//   enabled=1, deleted_at NULL          → Active      the operator had it armed
//   enabled=0, deleted_at NULL, flat    → Paused      the operator turned it off
//   enabled=0, deleted_at NULL, in pos  → Pausing     D-4: not Active means flat,
//                                                     and this row is not flat yet
//   deleted_at NOT NULL (trash/retired) → Paused      see below
//
// **The mapping only ever moves a row toward "not managed".** No row becomes
// `Active` that was not already `enabled = 1 AND deleted_at IS NULL`, so a
// deployment the operator had disabled cannot be silently re-armed. The
// tolerated failure is the opposite one — something stays paused that the
// operator thought was on, which is visible on the card and one click to fix.
//
// **Trashed and tombstoned rows map to `Paused` even when they hold an open
// trade**, which is the one place this deliberately does not enforce D-4.
// `Pausing` is an instruction to fire a market exit, and firing one at a row
// the operator threw away weeks ago — on the strength of a trade row that may
// simply never have been reconciled — is a worse first action than leaving it
// where it already is. Those rows keep the coverage they have today: the
// reconciler unions `listAccountsWithReconcilableTrades`, and the session-end
// clock guard unions `getAllOpenTrades`, neither of which reads status.
registerMigration((d) => {
  const cols = d.prepare(`PRAGMA table_info(deployments)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "status")) {
    d.exec(`ALTER TABLE deployments ADD COLUMN status TEXT`);
  }
  d.exec(`CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status)`);

  type LegacyRow = { id: string; enabled: number; deleted_at: string | null };
  const legacy = d
    .prepare(`SELECT id, enabled, deleted_at FROM deployments WHERE status IS NULL`)
    .all() as LegacyRow[];
  if (legacy.length === 0) return;

  // Cross-table read: `strategy_trades` is owned by `trades.ts` and there is
  // no import edge, so on a fresh database it may not exist yet. Guard and
  // no-op — a fresh database has no deployments either, and the next boot
  // re-runs this block for any row still carrying a NULL status.
  const tradesExist = Boolean(
    d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_trades'`).get(),
  );
  const openTrade = tradesExist
    ? d.prepare(
        `SELECT 1 FROM strategy_trades
          WHERE deployment_id = ?
            AND status IN ('pending_entry', 'open', 'pending_exit')
          LIMIT 1`,
      )
    : null;

  // `enabled` moves with `status`, exactly as every application write site
  // does. The migration writing `status` alone was the one place that could
  // desync the mirror — and it is the place that matters, because a legacy
  // `enabled = 1` trashed row (or any value other than 0/1) would otherwise
  // be left claiming Active to a rolled-back build reading the old column.
  const update = d.prepare(
    `UPDATE deployments SET status = ?, enabled = CASE WHEN ? = 'Active' THEN 1 ELSE 0 END WHERE id = ?`,
  );
  const counts: Record<DeploymentStatus, number> = {
    Active: 0,
    Pausing: 0,
    Paused: 0,
    Destroying: 0,
  };
  const pausingIds: string[] = [];
  const tx = d.transaction((rows: LegacyRow[]) => {
    for (const r of rows) {
      let status: DeploymentStatus;
      if (r.deleted_at != null) {
        status = "Paused";
      } else if (r.enabled === 1) {
        status = "Active";
      } else {
        status = openTrade?.get(r.id) ? "Pausing" : "Paused";
      }
      counts[status] += 1;
      if (status === "Pausing") pausingIds.push(r.id);
      update.run(status, status, r.id);
    }
  });
  tx(legacy);
  log.event(
    "db_migration_applied",
    "db",
    `status backfill: ${legacy.length} deployment(s) → ` +
      `Active=${counts.Active} Pausing=${counts.Pausing} Paused=${counts.Paused}`,
  );
  // A non-zero `Pausing` count means the closing guard will submit market
  // orders against live positions within ~15s of this boot. That is D-4
  // working as designed, and it is also a change from what those positions
  // did yesterday — so it warns, and it names the rows.
  if (pausingIds.length > 0) {
    log.event(
      "deployment_backfill_pausing",
      "db",
      `status backfill: ${pausingIds.length} disabled deployment(s) hold an open trade and were set Pausing — ` +
        `the closing guard will flatten them at market on this boot: ${pausingIds.join(", ")}`,
    );
  }
});

// 2026-04-27 Phase 2: deployment param-flow redesign.
//
// Drops takeProfitTicks / stopLossTicks / rewardToRisk / targetMode /
// targetRangePercent / useEmaTrendFilter / emaPeriod (slope-filter relic).
// It converted them into the deployment-level Override / Max / RR knobs
// until phase 1 deleted those too; what is left is the strip, the cooldown
// move from `strategy.config.cooldownSeconds` to a per-deployment param, and
// the session reshape. The migration runs once per row; subsequent loads
// short-circuit via the `__paramSchemaV2` flag we stamp on every migrated
// row — which is why the keys phase 1 retired are stripped by
// `migrateLegacyParamOverrides` at load rather than here: this block never
// sees a row that already carries them.
registerMigration((d) => {
  type ParamsRow = { id: string; strategy_key: string; param_values: string };
  const rows = d
    .prepare("SELECT id, strategy_key, param_values FROM deployments")
    .all() as ParamsRow[];
  const update = d.prepare("UPDATE deployments SET param_values = ? WHERE id = ?");
  const tx = d.transaction((items: ParamsRow[]) => {
    for (const r of items) {
      let pv: Record<string, unknown>;
      try {
        pv = JSON.parse(r.param_values);
      } catch {
        continue;
      }
      if (pv.__paramSchemaV2 === true) continue;

      // This block used to derive a `riskRewardRatio` and seed
      // `stopLossOverrideTicks` / `maxStopLossTicks`. All three are deleted: a
      // strategy owns both legs of its bracket, so there is no deployment-level
      // target ratio or stop override to convert into. Per the shim's rule in
      // [filters.md](../../../docs/modules/trading/filters.md), a translation
      // whose target no longer exists is **dropped and announced**, never
      // approximated — so the derivation is gone rather than writing keys
      // nothing reads, and the one value a row could lose says so.
      const oldSl = Number(pv.stopLossTicks ?? 0);
      if (Number.isFinite(oldSl) && oldSl > 0) {
        log.event(
          "db_migration_applied",
          "db",
          `migration: deployment ${r.id} (${r.strategy_key}) carried stopLossTicks=${oldSl}; ` +
            `the deployment-level stop override was deleted, so the value is dropped and the ` +
            `strategy's own stop applies from now on`,
          { deploymentId: r.id },
        );
      }

      // Cooldown moves from strategy config to deployment params. Read the
      // strategy's old static value before Phase 2 ripped it; fall back to
      // 60 (the new schema default) when the strategy is gone.
      if (!("cooldownSeconds" in pv) || typeof pv.cooldownSeconds !== "number") {
        const strategy = getStrategy(r.strategy_key);
        // Old config field is gone in TS but the value may still exist on
        // the registered module if a stale build is loaded; fall back to 60.
        const legacyCooldown = strategy
          ? Number((strategy.config as unknown as { cooldownSeconds?: number }).cooldownSeconds ?? 60)
          : 60;
        pv.cooldownSeconds = Number.isFinite(legacyCooldown) ? legacyCooldown : 60;
      }

      if (!Array.isArray(pv.additionalSessions)) {
        pv.additionalSessions = [];
      }
      // The legacy `activeStart`/`activeEnd` → `mainSession` projection is
      // gone with the key it wrote: the trading window is the playbook's
      // `config.session` now, so there is nothing on a row to project into.
      // `mainSession` itself is stripped on load by `RETIRED_PARAM_KEYS`,
      // which reaches rows this block short-circuits on. The
      // `additionalSessions` decision is still the boot-time runner's —
      // extras are disjoint from the primary window and may carry an open
      // position, and the runner consults broker state before disabling
      // the row.
      if (!Array.isArray(pv.pauseWindows)) {
        pv.pauseWindows = [];
      }

      // Strip stale keys.
      delete pv.takeProfitTicks;
      delete pv.stopLossTicks;
      delete pv.rewardToRisk;
      delete pv.targetMode;
      delete pv.targetRangePercent;
      delete pv.useEmaTrendFilter;
      delete pv.emaPeriod; // legacy slope-filter relic
      delete pv.atrBracketsEnabled;
      delete pv.atrPeriod;
      delete pv.atrTpMultiplier;
      delete pv.atrSlMultiplier;

      pv.__paramSchemaV2 = true;
      update.run(JSON.stringify(pv), r.id);
    }
  });
  tx(rows);
});

/**
 * Every read of a leg, with its parent's params attached.
 *
 * **Params live on the parent and nowhere else.** The leg's own
 * `param_values` column is written `'{}'` at insert and never read — same
 * shape as `enabled`, and for the same reason (it is `NOT NULL`, so an
 * INSERT cannot omit it). `resolveDeploymentParams` used to reconcile two
 * sources; there is one now.
 *
 * A correlated subquery rather than a join, deliberately: `deployments` and
 * `deployment_groups` share seven column names, and a join would make every
 * `WHERE deleted_at IS NULL` in this file ambiguous. The candidate set is
 * tens of rows.
 *
 * `parent_param_values` is null when the parent is gone — a soft-delete
 * cascade caught mid-flight, or a row predating this shape. It reads as an
 * empty blob, which resolves no size, which is the engine's skip-the-tick
 * path.
 */
const LEG_SELECT = `
  SELECT deployments.*,
         (SELECT param_values FROM deployment_groups
           WHERE deployment_groups.id = deployments.group_id) AS parent_param_values
    FROM deployments`;

interface DeploymentRow {
  id: string;
  strategy_key: string;
  account_id: number;
  ticker: string;
  contract_id: string | null;
  /** Legacy mirror of `status === 'Active'`. **Write-only** — nothing in the
   *  app reads it. It survives because the column is `NOT NULL` with no
   *  default, so an INSERT cannot omit it, and because a pre-P3 build
   *  reading it sees `Pausing` / `Destroying` as off, which is the safe
   *  direction. Every write site sets it beside `status`; none may set it
   *  alone. */
  enabled: number;
  status: string | null;
  /** Legacy, and dead in exactly the way `enabled` is: written `'{}'` at
   *  insert because the column is `NOT NULL`, never read. Params live on
   *  the parent — see {@link LEG_SELECT}. */
  param_values: string;
  /** The parent's `param_values`, attached by {@link LEG_SELECT}. Null when
   *  the parent row is gone. */
  parent_param_values: string | null;
  created_at: string;
  updated_at: string;
  orphaned_at: string | null;
  orphan_reason: string | null;
  deleted_at: string | null;
  tombstoned_at: string | null;
  version: number;
  name: string | null;
  pending_reconciliation: string | null;
  group_id: string | null;
  enabled_snapshot: number | null;
}

function rowToDeployment(r: DeploymentRow): Deployment {
  return {
    id: r.id,
    strategyKey: r.strategy_key,
    accountId: r.account_id,
    ticker: r.ticker as TickerSymbol,
    contractId: r.contract_id,
    status: parseDeploymentStatus(r.status),
    paramValues: r.parent_param_values == null ? {} : JSON.parse(r.parent_param_values),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    orphanedAt: r.orphaned_at,
    orphanReason: r.orphan_reason,
    deletedAt: r.deleted_at,
    tombstonedAt: r.tombstoned_at,
    version: r.version,
    name: r.name,
    pendingReconciliation: r.pending_reconciliation,
    // The column is nullable and a pre-model row reads NULL, so the cast this
    // replaced was the type claiming something the boot guard exists to count.
    // `""` rather than `string | null`: it is the id of no parent, and every
    // consumer already answers correctly for a parent that is not there —
    // `getGroup("")` is null and `groupCache.get("")` is undefined, so the
    // row takes no entry. A nullable type would instead make the compiler
    // *demand* a second branch at each of those sites, which is the
    // standalone shape re-entering through the type system. Nothing writes it
    // back: no UPDATE in this file sets `group_id`.
    groupId: r.group_id ?? "",
    enabledSnapshot:
      r.enabled_snapshot == null ? null : r.enabled_snapshot === 1,
  };
}

/** Active deployments — excludes soft-deleted rows. Almost every caller
 *  wants this view; the trash tab uses listDeletedDeployments instead. */
export function listDeployments(): Deployment[] {
  const rows = getDb()
    .prepare(`${LEG_SELECT} WHERE deleted_at IS NULL ORDER BY created_at ASC`)
    .all() as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/** Soft-deleted, *not* tombstoned deployments — newest first. Drives the
 *  Trash tab, which only surfaces rows the user can still Recreate or
 *  Retire. Tombstoned rows are excluded; they live on solely to keep
 *  trade attribution intact and surface via getTombstones() / the
 *  Retired bucket. */
export function listDeletedDeployments(): Deployment[] {
  const rows = getDb()
    .prepare(`
      ${LEG_SELECT}
      WHERE deleted_at IS NOT NULL AND tombstoned_at IS NULL
      ORDER BY deleted_at DESC
    `)
    .all() as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/** Tombstoned deployments for an account, newest first. Used by the
 *  All-Time card's Retired-bucket tooltip and any future surface that
 *  needs to label retired rows by name/strategy. */
export function getTombstones(accountId: number): Deployment[] {
  const rows = getDb()
    .prepare(`
      ${LEG_SELECT}
      WHERE account_id = ? AND tombstoned_at IS NOT NULL
      ORDER BY tombstoned_at DESC
    `)
    .all(accountId) as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/**
 * What the two post-SQL filters dropped, alongside what survived them.
 *
 * `deployments.length === 0` has two very different causes — the operator
 * has nothing running, or every managed row was withheld — and a boot that
 * cannot tell them apart reports a broker outage as an idle engine. Callers
 * that only need the list use `listManagedDeployments()`.
 */
export interface ManagedDeploymentsResult {
  deployments: Deployment[];
  /** Managed rows the live-account block refused, with the refusal reason. */
  withheldLiveAccounts: Array<{ id: string; accountId: number; reason: string }>;
  /** Managed rows dropped by the staging allowlist. Always empty on prod.
   *  Read by `runBootSequence`, which reports an all-skipped boot as
   *  `all-withheld` at error level rather than as an idle engine — a soft
   *  field with no consumer is a silent outage. */
  skippedNotAllowed: Array<{ id: string; accountId: number }>;
}

/**
 * Every deployment the engine is responsible for: `Active`, plus the two
 * closing statuses. A `Pausing` or `Destroying` row is work the engine has
 * not finished, so it stays in the set until it settles — that is what
 * replaced the `d.enabled || position != null` widening the exit loop used
 * to carry.
 */
export function listManagedDeployments(): Deployment[] {
  return readManagedDeployments().deployments;
}

export function readManagedDeployments(): ManagedDeploymentsResult {
  const rows = getDb()
    .prepare(
      `${LEG_SELECT}
        WHERE status IN ('Active', 'Pausing', 'Destroying') AND deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all() as DeploymentRow[];
  const all = rows.map(rowToDeployment);
  // Single source of truth: filter here so every engine entry point
  // (boot in instrumentation.ts, /api/engine/route.ts) inherits both
  // filters without having to remember to apply them at each call site.
  // The staging allowlist is null on prod (no filter) and a populated
  // ReadonlySet on staging (PRAC ids derived from /Account/search at boot).
  const allowed = getStagingAllowlist();
  // One query for the whole batch, to sit alongside the memoized allowlist
  // rather than a prepare-and-get per row.
  const verdicts = autoTradeVerdictsForAccountIds(all.map((d) => d.accountId));
  const kept: Deployment[] = [];
  const withheldLiveAccounts: ManagedDeploymentsResult["withheldLiveAccounts"] = [];
  const skippedNotAllowed: ManagedDeploymentsResult["skippedNotAllowed"] = [];
  // A detached row (`orphanReason` set) is deliberately not filtered here: it
  // stays in the set so a position it holds is still managed out, and the
  // engine's entry gate refuses its entries (engine-account-entry-gate.ts,
  // A75). Withholding it here dropped an open position out of the exit loop.
  for (const d of all) {
    // Live-account block, second layer. The lifecycle routes refuse to
    // create or enable one of these at all, so on a healthy install this
    // never fires — which is exactly why it must stay. It is what covers
    // rows written before the block shipped, and any row that arrives by a
    // path nobody screened. Do not delete it as redundant with the API
    // check; the API check cannot see a row it did not write.
    // Every id in the batch has an entry; the `??` is the same fail-closed
    // answer an unknown account gets, not a permissive default.
    //
    // **A closing row is exempt, and the exemption is the rule's own scope.**
    // The block's subject is auto-trading; refusing to *close* a live
    // position inverts its intent, which is why `flatten-all` is never
    // screened either (brokers/README). Withholding a `Pausing` row would
    // strand it forever — nothing else would ever flatten it — while
    // letting it through cannot produce an entry, because entry-eval gates
    // on `status === "Active"` and a closing row is by definition not that.
    // This is the same predicate over a narrower set, not a second one.
    const verdict = verdicts.get(d.accountId) ?? autoTradeVerdict(null);
    if (!verdict.permitted && isClosingStatus(d.status)) {
      log.event(
        "deployment_withheld",
        "db",
        `deployment ${d.id} is ${d.status} on withheld account ${d.accountId} — ` +
          `kept so the close can complete; it cannot enter (${verdict.reason})`,
        { deploymentId: d.id, accountId: d.accountId },
      );
    } else if (!verdict.permitted) {
      withheldLiveAccounts.push({ id: d.id, accountId: d.accountId, reason: verdict.reason });
      log.event(
        "deployment_withheld",
        "db",
        `deployment ${d.id} withheld from the engine: account ${d.accountId} — ${verdict.reason}`,
        { deploymentId: d.id, accountId: d.accountId },
      );
      continue;
    }
    if (allowed && !allowed.has(d.accountId)) {
      skippedNotAllowed.push({ id: d.id, accountId: d.accountId });
      log.event(
        "deployment_skipped_allowlist",
        "db",
        `deployment ${d.id} skipped: account ${d.accountId} not in staging allowlist`,
        { deploymentId: d.id, accountId: d.accountId },
      );
      continue;
    }
    kept.push(d);
  }
  return { deployments: kept, withheldLiveAccounts, skippedNotAllowed };
}

export function getDeployment(id: string): Deployment | null {
  const row = getDb()
    .prepare(`${LEG_SELECT} WHERE id = ?`)
    .get(id) as DeploymentRow | undefined;
  return row ? rowToDeployment(row) : null;
}

/**
 * Returns every `Active` deployment on the same
 * `(accountId, ticker, strategyKey)` triple, excluding `excludeId`. The
 * caller resolves each row's window with `sessionForStrategyKey` and applies
 * the wraparound-aware overlap predicate to detect conflicts.
 *
 * Overlap can't be filtered in SQL because the window is the playbook's
 * `config.session` and not a column; the candidate set is small (one strategy
 * per account+ticker rarely runs 10+ legs), so TS-side filtering is cheap.
 */
export function findConflictingDeployments(
  accountId: number,
  ticker: string,
  strategyKey: string,
  excludeId?: string,
): Deployment[] {
  // `Active` only, deliberately: a `Pausing` row is on its way out and must
  // not block the operator from arming a replacement while it closes.
  const sql = excludeId
    ? `${LEG_SELECT}
         WHERE account_id = ? AND ticker = ? AND strategy_key = ?
               AND status = 'Active' AND deleted_at IS NULL AND id != ?`
    : `${LEG_SELECT}
         WHERE account_id = ? AND ticker = ? AND strategy_key = ?
               AND status = 'Active' AND deleted_at IS NULL`;
  const stmt = getDb().prepare(sql);
  const rows = (excludeId
    ? stmt.all(accountId, ticker, strategyKey, excludeId)
    : stmt.all(accountId, ticker, strategyKey)) as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/**
 * Cross-strategy candidates on the same `(accountId, contractId)` —
 * different `strategyKey`. Used for the non-blocking warning when two
 * strategies are simultaneously enabled on the same account+contract
 * during overlapping main windows. SQL filters by ticker (cheap proxy
 * for contract — contract_id often null until first tick); caller
 * narrows by overlap math.
 */
export function findCrossStrategyDeployments(
  accountId: number,
  ticker: string,
  strategyKey: string,
  excludeId?: string,
): Deployment[] {
  const sql = excludeId
    ? `${LEG_SELECT}
         WHERE account_id = ? AND ticker = ? AND strategy_key != ?
               AND status = 'Active' AND deleted_at IS NULL AND id != ?`
    : `${LEG_SELECT}
         WHERE account_id = ? AND ticker = ? AND strategy_key != ?
               AND status = 'Active' AND deleted_at IS NULL`;
  const stmt = getDb().prepare(sql);
  const rows = (excludeId
    ? stmt.all(accountId, ticker, strategyKey, excludeId)
    : stmt.all(accountId, ticker, strategyKey)) as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/** Active deployments flagged with `pending_reconciliation`. Drives the
 *  Active-tab banner + per-row badge. */
export function listPendingReconciliationDeployments(): Deployment[] {
  const rows = getDb()
    .prepare(`
      ${LEG_SELECT}
      WHERE pending_reconciliation IS NOT NULL AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `)
    .all() as DeploymentRow[];
  return rows.map(rowToDeployment);
}

// `sessionForStrategyKey` lives in the strategy registry, which is all it
// needs; a copy here would tie a pure lookup to `better-sqlite3`. Re-exported
// so the conflict helpers below and the routes that call them read one import.
export { sessionForStrategyKey };

/** Read pause windows out of `paramValues`. Returns empty list when
 *  missing or malformed. Each entry that fails the shape check is
 *  silently dropped. */
export function readPauseWindows(
  paramValues: Record<string, unknown>,
): PauseWindow[] {
  const pw = paramValues.pauseWindows;
  if (!Array.isArray(pw)) return [];
  const out: PauseWindow[] = [];
  for (const item of pw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<PauseWindow>;
    if (typeof o.start !== "string" || typeof o.end !== "string") continue;
    out.push({ start: o.start, end: o.end });
  }
  return out;
}

/**
 * Filter `findConflictingDeployments` results to those whose playbook's
 * session overlaps the candidate's. Pure TS — doesn't touch the DB. Returns
 * the offenders so the API caller can name them in the error.
 *
 * Each row's window comes from its own `strategyKey`, so a cross-strategy
 * check compares two playbooks' declared windows rather than two copies of one
 * operator field. A row whose strategy is unregistered claims no window and is
 * not a conflict — the same reading `sessionWindowsFor` takes in the engine.
 */
export function filterMainSessionOverlaps(
  candidate: MainSession,
  rows: ReadonlyArray<Deployment>,
): Deployment[] {
  const out: Deployment[] = [];
  for (const r of rows) {
    const ms = sessionForStrategyKey(r.strategyKey);
    if (!ms) continue;
    if (mainSessionsOverlap(candidate, ms)) out.push(r);
  }
  return out;
}

/**
 * Back-compat: returns the first overlapping deployment, or null. New
 * code should use `findConflictingDeployments` +
 * `filterMainSessionOverlaps` for the full conflict list.
 */
export function findConflictingDeployment(
  accountId: number,
  ticker: string,
  strategyKey: string,
  candidate: MainSession,
  excludeId?: string,
): Deployment | null {
  const rows = findConflictingDeployments(accountId, ticker, strategyKey, excludeId);
  const overlaps = filterMainSessionOverlaps(candidate, rows);
  return overlaps[0] ?? null;
}

export interface InsertDeploymentInput {
  strategyKey: string;
  accountId: number;
  ticker: TickerSymbol;
  contractId: string | null;
  /** A new row is only ever `Active` or `Paused` — nothing is born mid-close. */
  status: OperatorDeploymentStatus;
  /** The parent's params, for the returned object only. **Nothing per-leg
   *  is written from it** — the leg's own column is dead (see
   *  {@link LEG_SELECT}) and the next read comes from the parent. */
  paramValues: Deployment["paramValues"];
  /** Optional human label. Null falls back to strategy display name in UI. */
  name?: string | null;
  /** The parent this leg belongs to. Required — a leg with no parent is
   *  the standalone shape, which no longer exists. */
  groupId: string;
  /** "Was this leg Active" for a leg created under a *disabled* parent.
   *  `enableGroupAndRestore` skips a NULL snapshot, so a leg inserted
   *  without one never comes back when the parent is enabled. */
  enabledSnapshot?: boolean | null;
}

export function insertDeployment(input: InsertDeploymentInput): Deployment {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const name = normalizeName(input.name);
  const groupId = input.groupId;
  const enabledSnapshot = input.enabledSnapshot ?? null;
  getDb()
    .prepare(`
      INSERT INTO deployments (
        id, strategy_key, account_id, ticker, contract_id,
        status, enabled, param_values, created_at, updated_at, name,
        group_id, enabled_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      input.strategyKey,
      input.accountId,
      input.ticker,
      input.contractId,
      input.status,
      input.status === "Active" ? 1 : 0,
      "{}",
      now,
      now,
      name,
      groupId,
      enabledSnapshot == null ? null : enabledSnapshot ? 1 : 0,
    );
  return {
    id,
    strategyKey: input.strategyKey,
    accountId: input.accountId,
    ticker: input.ticker,
    contractId: input.contractId,
    status: input.status,
    paramValues: input.paramValues,
    createdAt: now,
    updatedAt: now,
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name,
    pendingReconciliation: null,
    groupId,
    enabledSnapshot,
  };
}

/**
 * What a leg's own edit can change.
 *
 * **No `ticker` and no `strategyKey`.** A deployment's identity is strategy
 * plus instrument, pinned at creation; re-pointing one leaves a single row
 * whose trade history spans two instruments. Delete and recreate is the
 * honest operation. `accountId` stays, because moving a *detached* leg onto
 * a live account is the orphan-recovery path and does not change what the
 * deployment is.
 */
export type DeploymentPatch = Partial<{
  accountId: number;
  contractId: string | null;
  /** Any status, including the transient two — the engine writes those
   *  through this same path. Routes narrow their own input to
   *  {@link OperatorDeploymentStatus} before they get here. */
  status: DeploymentStatus;
  name: string | null;
  enabledSnapshot: boolean | null;
}>;

/**
 * Would applying this patch arm the row, or put it somewhere new?
 *
 * `PATCH /api/deployments/[id]` screens the *resulting* account through
 * `screenAccountsForAutoTrade` when this returns true. Two clauses, and
 * both are load-bearing:
 *
 *  - the patch turns a row that was not `Active` into `Active`;
 *  - the account changed, even on a paused row, because the next toggle
 *    would then start trading on an account nothing ever screened.
 *
 * False for every other patch — a rename or a pause in place, on an `Active`
 * row as much as a paused one. An `Active` row on an account that turned
 * dead, locked or OCO-off keeps its row; the engine skips its entries, and
 * one on a live account is withheld by the engine filter regardless, so
 * refusing its rename would make the refusal itself the hazard. A patch to
 * `Pausing` is a *close*, which is outside the rule's scope entirely.
 */
export function patchWouldBeTradeable(
  existing: Pick<Deployment, "status" | "accountId">,
  patch: Pick<DeploymentPatch, "status" | "accountId">,
): boolean {
  const nextAccountId = patch.accountId ?? existing.accountId;
  return (
    (patch.status === "Active" && existing.status !== "Active") ||
    nextAccountId !== existing.accountId
  );
}

export function updateDeployment(id: string, patch: DeploymentPatch): Deployment | null {
  const existing = getDeployment(id);
  if (!existing) return null;

  const nextVersion = existing.version + 1;

  // When a leg's status is being changed while its parent is currently
  // disabled (enabled=0), the snapshot column tracks "intended state" —
  // write "would this be Active" to enabled_snapshot so re-enable preserves
  // trader intent end-to-end. No-op for legs whose parent is enabled. Read
  // the parent with a direct SQL hit to avoid a circular import on
  // `deployment-groups.ts` (that module also imports helpers from this file).
  let nextEnabledSnapshot: boolean | null =
    "enabledSnapshot" in patch ? (patch.enabledSnapshot ?? null) : existing.enabledSnapshot;
  if (patch.status != null && !("enabledSnapshot" in patch)) {
    const parentRow = getDb()
      .prepare(`SELECT enabled FROM deployment_groups WHERE id = ?`)
      .get(existing.groupId) as { enabled: number } | undefined;
    if (parentRow && parentRow.enabled === 0) {
      nextEnabledSnapshot = patch.status === "Active";
    }
  }

  const merged: Deployment = {
    ...existing,
    ...patch,
    name: "name" in patch ? normalizeName(patch.name) : existing.name,
    updatedAt: new Date().toISOString(),
    version: nextVersion,
    enabledSnapshot: nextEnabledSnapshot,
  };

  // Single UPDATE — version bump is atomic with the actual write so the
  // row never persists in a "config changed but version didn't" state.
  getDb()
    .prepare(`
      UPDATE deployments
      SET strategy_key = ?, account_id = ?, ticker = ?, contract_id = ?,
          status = ?, enabled = ?, updated_at = ?, version = ?, name = ?,
          enabled_snapshot = ?
      WHERE id = ?
    `)
    .run(
      merged.strategyKey,
      merged.accountId,
      merged.ticker,
      merged.contractId,
      merged.status,
      merged.status === "Active" ? 1 : 0,
      merged.updatedAt,
      nextVersion,
      merged.name,
      merged.enabledSnapshot == null ? null : merged.enabledSnapshot ? 1 : 0,
      id,
    );
  return merged;
}

/** List every leg in a group (active rows, ordered by created_at). */
export function listGroupLegs(groupId: string): Deployment[] {
  const rows = getDb()
    .prepare(`
      ${LEG_SELECT}
      WHERE group_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `)
    .all(groupId) as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/** Trim and collapse empty-strings to null so the UI's "leave blank to use
 *  the strategy default" affordance writes a real null instead of "" — the
 *  fallback rendering keys on `name == null`. */
function normalizeName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Soft-delete: mark the row as deleted and settle it to `Paused` so the
 *  engine doesn't keep evaluating it. The row stays so strategy_trades
 *  remain attached. Use this for the user-driven Delete button — and, for
 *  a deployment that still holds a position, only once it is confirmed
 *  flat: `DELETE` writes `Destroying` first and this is the reap. */
export function softDeleteDeployment(id: string): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE deployments
      SET deleted_at = ?, status = 'Paused', enabled = 0, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `)
    .run(now, now, id);
  return result.changes > 0;
}

/**
 * Every row the engine still owes a close: `Pausing` and `Destroying`.
 *
 * Read straight from the table rather than from the engine's in-memory
 * deployment set, because that set is emptied by `stop()` while the
 * obligation is not. A closing row survives a restart holding its status,
 * which is the property D-5 asks for, and this is the query that finds it
 * again. Soft-deleted rows are excluded — trash is settled by definition
 * (see the status backfill migration for why).
 */
export function listClosingDeployments(): Deployment[] {
  const rows = getDb()
    .prepare(`
      ${LEG_SELECT}
      WHERE status IN ('Pausing', 'Destroying') AND deleted_at IS NULL
      ORDER BY created_at ASC
    `)
    .all() as DeploymentRow[];
  return rows.map(rowToDeployment);
}

/**
 * Settle a `Pausing` row once it is confirmed flat.
 *
 * Conditional on the row still being `Pausing`, so a status some other writer
 * put there between the flat confirmation and this write is not overwritten.
 * Defence in depth: no operator route writes `Active` over a closing row any
 * more — each refuses it — so this guards against a writer added later rather
 * than a path in use. Returns whether the transition actually happened.
 */
export function settlePausingDeployment(id: string): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE deployments
      SET status = 'Paused', enabled = 0, updated_at = ?
      WHERE id = ? AND status = 'Pausing'
    `)
    .run(now, id);
  return result.changes > 0;
}

/**
 * Reap a `Destroying` row once it is confirmed flat: the soft-delete that
 * `DELETE /api/deployments/[id]` could not perform while a position was
 * open. Same conditional-on-status shape as {@link settlePausingDeployment}.
 *
 * Returns the row's `groupId` when the reap happened, so the caller can run
 * the same last-leg parent cascade the immediate path runs; `undefined` when
 * nothing was reaped.
 */
export function reapDestroyingDeployment(id: string): { groupId: string | null } | undefined {
  const now = new Date().toISOString();
  const existing = getDeployment(id);
  const result = getDb()
    .prepare(`
      UPDATE deployments
      SET deleted_at = COALESCE(deleted_at, ?), status = 'Paused', enabled = 0, updated_at = ?
      WHERE id = ? AND status = 'Destroying'
    `)
    .run(now, now, id);
  if (result.changes === 0) return undefined;
  return { groupId: existing?.groupId ?? null };
}

/** Tombstone — the Trash-tab "Retire" path. Stamps `tombstoned_at`
 *  instead of removing the row, so strategy_trades rows keep a valid
 *  foreign key for attribution. Also force-disables and
 *  stamps `deleted_at` if it wasn't already (covers the path where a
 *  caller retires a row that was never soft-deleted first — possible
 *  via a direct DELETE ?hard=true on a still-active deployment). All
 *  config (param_values, filter_config, name) is preserved for
 *  audit/post-mortem. Engine excludes the row via the existing
 *  `deleted_at IS NULL` filter on active queries. Idempotent: a row
 *  already tombstoned returns false (no rows changed). */
export function deleteDeployment(id: string): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      UPDATE deployments
      SET tombstoned_at = ?,
          deleted_at = COALESCE(deleted_at, ?),
          status = 'Paused',
          enabled = 0,
          updated_at = ?
      WHERE id = ? AND tombstoned_at IS NULL
    `)
    .run(now, now, now, id);
  return result.changes > 0;
}

/** One-time backfill: synthesize tombstone rows for pre-Track-4 orphans
 *  (trades whose `deployment_id` no longer matches any deployment row).
 *  Lets the Retired bucket label these rows with "(retired deployment)"
 *  + their account/strategy/ticker instead of "deployment unknown".
 *
 *  Cheap — one INSERT per distinct orphan deployment_id, idempotent
 *  via INSERT OR IGNORE on the primary key. Account / strategy_key /
 *  ticker are pulled from the most recent trade row referencing the
 *  orphan id; if those columns are inconsistent across the trade
 *  history we accept the latest as canonical (orphans don't get edits
 *  after this anyway). Synthetic rows have null param_values/contract_id
 *  to make their origin obvious if anyone ever reads them. */
registerMigration((d) => {
  type OrphanRow = {
    deployment_id: string;
    account_id: number;
    strategy_key: string;
    ticker: string;
  };
  // Fresh-DB guard: migrations register at module-import time and run on
  // first `getDb()` call in registration order. `deployments.ts` does not
  // import `trades.ts`, so on a brand-new DB this backfill can fire
  // before `strategy_trades` exists (instrumentation imports deployments
  // first to list enabled rows; trades.ts only enters the graph once the
  // engine touches it). Short-circuit when the table isn't there yet —
  // the next boot, after trades.ts has registered its create, will run
  // the backfill normally. Existing DBs already carry strategy_trades so
  // this guard is a no-op for them.
  const tableExists = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_trades'`)
    .get();
  if (!tableExists) return;
  // Pick the most recent trade per orphan deployment_id so the synthetic
  // row carries the latest known (account, strategy, ticker) tuple.
  // Correlated subquery is fine here — runs once at boot, distinct
  // orphan ids are bounded by historical hard-delete count.
  const orphans = d
    .prepare(`
      SELECT t.deployment_id, t.account_id, t.strategy_key, t.ticker
      FROM strategy_trades t
      LEFT JOIN deployments d ON t.deployment_id = d.id
      WHERE d.id IS NULL
        AND t.deployment_id IS NOT NULL
        AND t.id = (
          SELECT MAX(t2.id) FROM strategy_trades t2
          WHERE t2.deployment_id = t.deployment_id
        )
    `)
    .all() as OrphanRow[];
  if (orphans.length === 0) return;
  const now = new Date().toISOString();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO deployments (
      id, strategy_key, account_id, ticker, contract_id,
      status, enabled, param_values, created_at, updated_at,
      deleted_at, tombstoned_at, name, version
    ) VALUES (?, ?, ?, ?, NULL, 'Paused', 0, '{}', ?, ?, ?, ?, ?, 1)
  `);
  const tx = d.transaction((rows: OrphanRow[]) => {
    for (const r of rows) {
      insert.run(
        r.deployment_id,
        r.strategy_key,
        r.account_id,
        r.ticker,
        now, now, now, now,
        "(retired deployment)",
      );
    }
  });
  tx(orphans);
  log.event(
    "db_migration_applied",
    "db",
    `track-4 backfill: created ${orphans.length} synthetic tombstone(s) for pre-existing orphan trades`,
  );
});

// 2026-05-04: collapse legacy ORB strategy_keys onto the canonical
// `opening-range-breakout`. Commit 184e179 merged `orb-15min` and
// `orb-overnight` into a single strategy with a runtime alias map; this
// rewrites the stored values so strict-equality reads (Strategies-page
// deploy-count filter, etc.) no longer depend on the resolver. Idempotent
// — once rewritten the WHERE clauses match no rows. Table-existence
// guards mirror the orphan-backfill block above: `deployment_groups` and
// `strategy_trades` are owned by other modules and may not have been
// created yet on a fresh DB, depending on import order.
registerMigration((d) => {
  const LEGACY = ["orb-15min", "orb-overnight"];
  const CANONICAL = "opening-range-breakout";
  const tableExists = (name: string): boolean =>
    Boolean(
      d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name),
    );
  const targets: { table: string; column: string }[] = [
    { table: "deployments", column: "strategy_key" },
    ...(tableExists("deployment_groups")
      ? [{ table: "deployment_groups", column: "strategy_key" }]
      : []),
    ...(tableExists("strategy_trades")
      ? [{ table: "strategy_trades", column: "strategy_key" }]
      : []),
  ];
  const tx = d.transaction(() => {
    let total = 0;
    for (const { table, column } of targets) {
      const info = d
        .prepare(
          `UPDATE ${table} SET ${column} = ? WHERE ${column} IN (${LEGACY.map(() => "?").join(",")})`,
        )
        .run(CANONICAL, ...LEGACY);
      total += info.changes;
    }
    return total;
  });
  const total = tx();
  if (total > 0) {
    log.event(
      "db_migration_applied",
      "db",
      `orb-key migration: rewrote ${total} row(s) to ${CANONICAL}`,
    );
  }
});

/** Every table whose `strategy_key` column joins a row to its playbook. */
export const STRATEGY_KEY_TABLES = [
  "deployments",
  "deployment_groups",
  "strategy_trades",
  "skipped_signals",
  "book_playbooks",
] as const;

/**
 * 2026-10-16: the six production keys renamed to the slugs of their display
 * names (strategies.md, Decisions). Re-runs every boot and matches nothing
 * once done. Tables owned elsewhere are guarded on existence.
 *
 * `OR IGNORE` because `book_playbooks`' primary key and `deployment_groups`'
 * cell index both include the key: a row whose new-key twin already exists
 * (only possible if an old build ran after this one) keeps its old key and is
 * named in a `db_migration_rows_kept` warn rather than failing the boot. No JSON column carries a
 * key — `param_snapshot` is params and the risk facts, `replay_result_json`
 * is bars and markers — and `engine_logs.message` is prose, left as written.
 */
export function renameStrategyKeys(d: ReturnType<typeof getDb>): void {
  const tableExists = (name: string): boolean =>
    Boolean(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  const pairs = Object.entries(RENAMED_KEYS);
  const report = d.transaction(() => {
    const applied: string[] = [];
    const kept: string[] = [];
    for (const table of STRATEGY_KEY_TABLES) {
      if (!tableExists(table)) continue;
      const update = d.prepare(`UPDATE OR IGNORE ${table} SET strategy_key = ? WHERE strategy_key = ?`);
      const left = d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE strategy_key = ?`);
      let changed = 0;
      for (const [old, next] of pairs) {
        changed += update.run(next, old).changes;
        const n = (left.get(old) as { n: number }).n;
        if (n > 0) {
          kept.push(
            `strategy-key rename: ${table}: ${n} row(s) kept the old key ${old} because a ${next} row already exists`,
          );
        }
      }
      if (changed > 0) applied.push(`strategy-key rename: ${table}: rewrote ${changed} row(s)`);
    }
    return { applied, kept };
  })();
  for (const line of report.applied) log.event("db_migration_applied", "db", line);
  for (const line of report.kept) log.event("db_migration_rows_kept", "db", line);
}

registerMigration(renameStrategyKeys);

/**
 * Mark a deployment as orphaned (account vanished). Idempotent: returns
 * `true` only when the call was a fresh transition from "not orphaned" to
 * "orphaned" — caller uses that signal to decide whether to send a Discord
 * notification, since multiple detection sites can race to mark the same
 * deployment within seconds and we don't want spam.
 */
export function markOrphaned(id: string, reason: string): boolean {
  const existing = getDeployment(id);
  if (!existing) return false;
  if (existing.orphanReason != null) return false; // already orphaned, no-op
  const now = new Date().toISOString();
  // Direct UPDATE, NOT updateDeployment — this bypasses the
  // group-disabled-window snapshot logic at the top of updateDeployment.
  // For a leg whose parent group is currently disabled, that means
  // `enabled_snapshot` won't be touched here: if the snapshot was 1
  // pre-orphan, group re-enable would attempt to restore the leg to
  // enabled even though its account no longer exists. That restore cannot
  // trade: the engine's entry gate refuses every entry of a row whose
  // `orphanReason` is set, whatever its status, while still managing out
  // any position it holds (engine-account-entry-gate.ts, A75).
  // If the user reassigns the leg to a live account (clearOrphaned
  // path in /api/deployments/[id] PATCH), the snapshot then governs
  // intended state correctly.
  // `Paused`, not `Pausing`: the account this deployment trades on is gone,
  // so there is nothing to submit a close through. Promising a flatten the
  // broker cannot accept would park the row in a transient state that could
  // never complete. Orphan recovery is `clear-orphan`, which re-arms it.
  //
  // **But an already-closing row keeps its status.** `Paused` is a claim the
  // deployment is flat; writing it over `Pausing` / `Destroying` retracts the
  // operator's own Destroy, drops the close obligation, and removes the row
  // from `listClosingDeployments()` so the guard stops retrying — while the
  // position is still open. Orphaning is reachable with no operator action
  // (an `AccountNotFound` from the very `placeOrder` the guard just issued,
  // or the 30-minute poll), so this arm is not hypothetical. The orphan
  // markers still land; only the lifecycle status is preserved, because the
  // obligation outlives the account's reachability and `clear-orphan` is the
  // recovery path either way.
  getDb()
    .prepare(`
      UPDATE deployments
      SET status = CASE WHEN status IN ('Pausing', 'Destroying') THEN status ELSE 'Paused' END,
          enabled = 0, orphaned_at = ?, orphan_reason = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(now, reason, now, id);
  return true;
}

/** Mark every enabled deployment for an account as orphaned. Returns the
 *  list of deployments that *transitioned* to orphaned by this call (not
 *  ones that were already orphaned). Used by the four detection sites:
 *  boot, placeOrder failure (errorCode AccountNotFound), 30min reconciler
 *  poll, deployments page render. */
export function markOrphanedByAccount(accountId: number, reason: string): Deployment[] {
  const candidates = listDeployments().filter(
    (d) => d.accountId === accountId && d.orphanReason == null,
  );
  const transitioned: Deployment[] = [];
  for (const d of candidates) {
    if (markOrphaned(d.id, reason)) {
      transitioned.push({
        ...d,
        // Mirror `markOrphaned`'s CASE — a closing row keeps its status, and
        // this optimistic copy is what callers hand to the engine.
        status: isClosingStatus(d.status) ? d.status : "Paused",
        orphanedAt: new Date().toISOString(),
        orphanReason: reason,
      });
    }
  }
  return transitioned;
}

/** Clear orphan markers (e.g. when the user recreates a deployment to a
 *  new account, the original row stays in trash with its orphan history,
 *  but we don't need this helper there — kept for symmetry). */
export function clearOrphaned(id: string): void {
  getDb()
    .prepare(`UPDATE deployments SET orphaned_at = NULL, orphan_reason = NULL WHERE id = ?`)
    .run(id);
}

/** Clear orphan markers AND re-enable the deployment. Used by the
 *  one-click clear-orphan UI path when the operator confirms the
 *  underlying issue is resolved (transient auth failure, maintenance
 *  window, etc). */
export function clearOrphanedAndReEnable(id: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE deployments
         SET orphaned_at = NULL, orphan_reason = NULL,
             status = 'Active', enabled = 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, id);
}

// ── Boot-time session migration runner ────────────────────────────────
//
// Two-phase migration:
//   1. Sync DB migration (above) projects `activeStart/activeEnd` → new
//      `mainSession`. `additionalSessions` is left untouched on rows
//      that had non-empty extras — those rows can't be auto-derived
//      into the new pause-windows model without trader judgment.
//   2. Boot-time runner (this) walks rows with non-empty
//      `additionalSessions`. For each, consults two sources to decide
//      "is this leg holding an open broker position?":
//        - Engine in-memory state (passed in by the caller; null when
//          the runner fires before the engine boots).
//        - Broker-side `searchOpenPositions(accountId)` query.
//      Clean rows: flip `enabled=0`, write `pending_reconciliation`,
//      strip `additionalSessions`. Position-holding rows: leave
//      everything intact, surface in the returned list so the caller
//      (instrumentation.ts) can emit the startup-blocking banner.

export interface SessionMigrationResult {
  migrated: Deployment[];
  blocked: Deployment[];
}

export interface SessionMigrationContext {
  /** Predicate the runner consults to determine "is this leg holding
   *  an open broker position right now?" Source-priority is the
   *  caller's responsibility: engine in-memory state when running,
   *  broker query as fallback. */
  hasOpenPosition(deployment: Deployment): Promise<boolean>;
}

export async function runPendingSessionMigrations(
  ctx: SessionMigrationContext,
): Promise<SessionMigrationResult> {
  const all = listDeployments();
  // Candidates: rows that still carry a non-empty `additionalSessions`
  // array. The sync DB migration left them in place because their
  // extras can't be auto-mapped to pause windows.
  const candidates = all.filter((d) => {
    const pv = d.paramValues as Record<string, unknown>;
    const extras = pv.additionalSessions;
    return Array.isArray(extras) && extras.length > 0;
  });
  const migrated: Deployment[] = [];
  const blocked: Deployment[] = [];
  if (candidates.length === 0) return { migrated, blocked };

  // **Every candidate is screened before anything is written, and a parent
  // with one blocked leg is left whole.** The write strips
  // `additionalSessions` from the *parent*, which is where every sibling leg
  // reads its session windows — so a leg-at-a-time loop lets a flat leg's
  // write land on the config an in-position sibling is still trading under.
  // That sibling stays `Active`, `collectSessionWindows` returns fewer
  // windows on its next tick, and `evaluateRealtimeExits` fires
  // `time_window_close` on a live position the migration was explicitly
  // refusing to touch — while the banner says it was blocked pending manual
  // review. Per-leg params made that impossible; a shared parent makes the
  // block a property of the parent, so it is resolved as one.
  const blockedGroups = new Set<string>();
  const verdicts = new Map<string, boolean>();
  for (const d of candidates) {
    let inPosition: boolean;
    try {
      inPosition = await ctx.hasOpenPosition(d);
    } catch (err) {
      log.event(
        "session_migration_check_failed",
        "db",
        `session-migration: hasOpenPosition check failed for deployment ${d.id} — ` +
          `assuming in-position to be safe: ${err instanceof Error ? err.message : String(err)}`,
        { deploymentId: d.id, accountId: d.accountId },
      );
      inPosition = true;
    }
    verdicts.set(d.id, inPosition);
    if (inPosition) blockedGroups.add(d.groupId);
  }

  for (const d of candidates) {
    if (blockedGroups.has(d.groupId)) {
      // Reported blocked whether or not this leg is the one holding the
      // position: the operator's unit of review is the deployment, and a
      // flat leg silently absent from both lists is a row nobody looks at.
      if (!verdicts.get(d.id)) {
        log.event(
          "session_migration_blocked",
          "db",
          `session-migration: deployment ${d.id} is flat but shares a parent with a leg ` +
            `holding an open position — the session config is shared, so it is left intact`,
          { deploymentId: d.id, accountId: d.accountId },
        );
      }
      blocked.push(d);
      continue;
    }
    // Clean — pause, strip extras, stamp pending_reconciliation. `Paused`
    // rather than `Pausing` is correct here and not a shortcut: the branch
    // is only reached when `hasOpenPosition` said no, which is the same
    // confirmation `Pausing` exists to wait for.
    const nextParams = { ...(d.paramValues as Record<string, unknown>) };
    delete nextParams.additionalSessions;
    const reason = "multi-session migration: review session config";
    const now = new Date().toISOString();
    // The stripped params land on the *parent*, which is where they live.
    // Two legs of one deployment run this twice; the write is idempotent.
    getDb()
      .prepare(`UPDATE deployment_groups SET param_values = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(nextParams), now, d.groupId);
    getDb()
      .prepare(`
        UPDATE deployments
        SET status = 'Paused',
            enabled = 0,
            pending_reconciliation = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(reason, now, d.id);
    log.event(
      "session_migration_done",
      "db",
      `session-migration: deployment ${d.id} paused + flagged pending_reconciliation`,
      { deploymentId: d.id, accountId: d.accountId },
    );
    migrated.push({
      ...d,
      status: "Paused",
      paramValues: nextParams as Deployment["paramValues"],
      pendingReconciliation: reason,
      updatedAt: now,
    });
  }
  return { migrated, blocked };
}

// ── The wipe was a release step, and this is what says it was skipped ─────
//
// *One deployment, N legs* is a shape change with no migration: nothing ran
// in prod, staging is a test environment, and both local `.db` files held
// zero deployment rows when the decision was taken
// (docs/proposals/ui-rework.md, "Before this ships"). So the sanctioned
// upgrade is a wipe, and a row that predates the shape can only arrive by
// skipping it.
//
// **It reports rather than refusing to boot.** Such a row is already inert:
// it has no parent, so `groupCache.get("")` is undefined and the entry gate
// refuses it, and its params read as an empty blob so its session windows
// name nothing. Nothing trades on it. Refusing to open the database would take
// Settings down with it and leave the operator no surface to fix anything
// from, which is a worse failure than a loud line — and the line is `error`
// because an inert row that renders is how somebody concludes a deployment
// is running when it is not.
registerMigration((d) => {
  const cols = d.prepare(`PRAGMA table_info(deployments)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "group_id")) return;
  const rows = d
    .prepare(`SELECT id FROM deployments WHERE group_id IS NULL AND deleted_at IS NULL`)
    .all() as { id: string }[];
  if (rows.length === 0) return;
  log.event(
    "deployment_premodel_rows",
    "db",
    `${rows.length} deployment row(s) predate the one-deployment-N-legs shape and have no parent — ` +
      `they cannot resolve a size and will never trade. The shape change is a wipe, not a migration: ` +
      `drop the database volume and re-run first-run setup. Rows: ${rows.map((r) => r.id).join(", ")}`,
  );
});
