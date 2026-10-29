import { getDb, registerMigration } from "./connection";
import type {
  Deployment,
  DeploymentGroup,
  DeploymentStatus,
  TickerSymbol,
} from "@/lib/trading/domain";
import {
  insertDeployment,
  listGroupLegs,
  softDeleteDeployment,
  updateDeployment,
} from "./deployments";
import { deepEqual } from "@/lib/trading/deep-equal";
import { log } from "@/lib/logger";

// Deployment groups: one canonical config that fans out to N accounts.
// Each leg is a `deployments` row carrying its own account_id; the group
// owns the shared config
// (params, filter_config, ticker, contract). Group `enabled` is its own
// source of truth — explicit, not derived from per-leg state.
registerMigration((d) => {
  d.exec(`
    CREATE TABLE IF NOT EXISTS deployment_groups (
      id TEXT PRIMARY KEY,
      name TEXT,
      strategy_key TEXT NOT NULL,
      param_values TEXT NOT NULL,
      filter_config TEXT,
      ticker TEXT NOT NULL,
      contract_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_deployment_groups_active
      ON deployment_groups(deleted_at);
  `);
  // `book_id` is the only pointer between a book and the row it materialises,
  // and it points one way: the derived row knows its book, the book stores no
  // deployment id. Nullable with **no DEFAULT**, which is persistence's rule
  // for a column that decides what the engine acts on — `NULL` is *hand-made*,
  // which is what every row on an existing install is, and a `DEFAULT ''`
  // would claim all of them belong to a book that does not exist, so the
  // reconciler would read them as a book that is off and pause every one on
  // the boot that introduced the column. There is no backfill for the same
  // reason: the unbackfilled value is the inert one.
  const cols = d.prepare(`PRAGMA table_info(deployment_groups)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "book_id")) {
    d.exec(`ALTER TABLE deployment_groups ADD COLUMN book_id TEXT`);
  }
  // One live derived row per book cell — (book, ticker, playbook) — as a
  // schema fact rather than a reconciler invariant: a second materialisation
  // throws instead of double-arming an account. The ticker joined the key when
  // a book stopped being one instrument (2026-10-11); the old
  // (book, playbook) index would refuse one playbook's MNQ and MES cells. `CREATE UNIQUE INDEX` throws on an existing
  // duplicate and a throw inside a migration is a boot failure, so any
  // duplicate a build between the ALTER and the index could have written is
  // folded first — oldest row keeps the binding, the rest read as hand-made
  // and keep running. Nothing is deleted here; the reconciler never deletes a
  // derived row either.
  //
  // **Oldest, not "the enabled one", and the loser keeps running unbound.**
  // Age is the only tiebreak that is a fact about the rows rather than a guess
  // at intent, and the alternative is worse in the direction that matters: the
  // unbound row is a hand-made deployment from this boot on, so the operator
  // sees it and can stop it, where a fold that dropped the enabled row would
  // leave the book's cell claiming a row that is off. No window this can run
  // in has more than one such pair — it exists for builds between the ALTER
  // and the index — so a richer rule would be untestable as well as guessy.
  const dupes = d
    .prepare(`
      SELECT book_id, ticker, strategy_key FROM deployment_groups
      WHERE book_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY book_id, ticker, strategy_key HAVING COUNT(*) > 1
    `)
    .all() as Array<{ book_id: string; ticker: string; strategy_key: string }>;
  for (const dup of dupes) {
    d.prepare(`
      UPDATE deployment_groups SET book_id = NULL
      WHERE book_id = ? AND ticker = ? AND strategy_key = ? AND deleted_at IS NULL
        AND id != (
          SELECT id FROM deployment_groups
          WHERE book_id = ? AND ticker = ? AND strategy_key = ? AND deleted_at IS NULL
          ORDER BY created_at ASC, rowid ASC LIMIT 1
        )
    `).run(
      dup.book_id, dup.ticker, dup.strategy_key,
      dup.book_id, dup.ticker, dup.strategy_key,
    );
  }
  d.exec(`
    DROP INDEX IF EXISTS idx_groups_book_playbook;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_book_cell
      ON deployment_groups(book_id, ticker, strategy_key)
      WHERE book_id IS NOT NULL AND deleted_at IS NULL;
  `);
});

interface GroupRow {
  id: string;
  name: string | null;
  strategy_key: string;
  param_values: string;
  filter_config: string | null;
  ticker: string;
  contract_id: string | null;
  enabled: number;
  book_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** **`book_id` is carried, not dropped.** The board asks *is this row a
 *  book's?* of every card, and the answer has to arrive on the domain type or
 *  the card reaches past its adapter to a raw row to find it. A row written
 *  before the column existed reads `NULL`, which is the hand-made reading. */
function rowToGroup(r: GroupRow): DeploymentGroup {
  return {
    id: r.id,
    name: r.name,
    strategyKey: r.strategy_key,
    paramValues: JSON.parse(r.param_values),
    ticker: r.ticker as TickerSymbol,
    contractId: r.contract_id,
    enabled: r.enabled === 1,
    bookId: r.book_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function listGroups(): DeploymentGroup[] {
  const rows = getDb()
    .prepare(`SELECT * FROM deployment_groups WHERE deleted_at IS NULL ORDER BY created_at ASC`)
    .all() as GroupRow[];
  return rows.map(rowToGroup);
}

export function getGroup(id: string): DeploymentGroup | null {
  const row = getDb()
    .prepare(`SELECT * FROM deployment_groups WHERE id = ?`)
    .get(id) as GroupRow | undefined;
  return row ? rowToGroup(row) : null;
}

export interface InsertGroupInput {
  name: string | null;
  strategyKey: string;
  paramValues: DeploymentGroup["paramValues"];
  ticker: TickerSymbol;
  contractId: string | null;
  enabled: boolean;
}

export function insertGroup(input: InsertGroupInput): DeploymentGroup {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const name = normalizeName(input.name);
  getDb()
    .prepare(`
      INSERT INTO deployment_groups (
        id, name, strategy_key, param_values, ticker, contract_id,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      name,
      input.strategyKey,
      JSON.stringify(input.paramValues),
      input.ticker,
      input.contractId,
      input.enabled ? 1 : 0,
      now,
      now,
    );
  return {
    id,
    name,
    strategyKey: input.strategyKey,
    paramValues: input.paramValues,
    ticker: input.ticker,
    contractId: input.contractId,
    enabled: input.enabled,
    // Every create is hand-made here, including the reconciler's: a derived
    // row is bound by `attachBookToGroup` inside the same transaction, which
    // is what keeps `book_id`'s single writer single.
    bookId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** One account under a deployment, as the creation path names it.
 *  An account and nothing else: contract count is the risk sizer's answer
 *  from that account's posture, so there is nothing per leg left for the
 *  operator to choose. */
export interface NewLegInput {
  accountId: number;
}

/**
 * Create a deployment and its legs in one transaction.
 *
 * **The only way a deployment comes into existence**, because there is no
 * standalone shape any more: a single-account deployment is a parent with
 * one leg, and the two rows have to land together or not at all. The
 * fan-out used to sit in `POST /api/groups` outside a transaction, which
 * could leave a parent with a subset of the accounts the operator picked.
 *
 * **`enabled_snapshot` is seeded when the parent is created disabled**, and
 * that is load-bearing rather than tidy. `enableGroupAndRestore` skips any
 * leg whose snapshot is NULL, so a deployment created Paused and later
 * resumed would flip the parent's flag while every leg stayed `Paused` —
 * a silent no-op on the ordinary create-then-resume flow. It was a filed
 * bug reachable only through promote-to-group and add-legs; under one
 * shape it is the common path.
 */
export function insertGroupWithLegs(
  input: InsertGroupInput,
  legs: readonly NewLegInput[],
): { group: DeploymentGroup; legs: Deployment[] } {
  const tx = getDb().transaction(() => {
    const group = insertGroup(input);
    const created = legs.map((leg) =>
      insertDeployment({
        strategyKey: input.strategyKey,
        accountId: leg.accountId,
        ticker: input.ticker,
        contractId: input.contractId,
        status: input.enabled ? "Active" : "Paused",
        paramValues: input.paramValues,
        name: input.name,
        groupId: group.id,
        enabledSnapshot: input.enabled ? null : true,
      }),
    );
    return { group, legs: created };
  });
  return tx();
}

/** **No `ticker` and no `strategyKey`.** Both are pinned at creation for
 *  every deployment — see {@link DeploymentPatch}, which took the same
 *  narrowing on the leg side. */
export type GroupPatch = Partial<{
  name: string | null;
  paramValues: DeploymentGroup["paramValues"];
  contractId: string | null;
  enabled: boolean;
}>;

/** The keys that decide *when* a deployment trades. A change to any of them
 *  is what clears `pending_reconciliation` — see {@link updateGroup}. The
 *  legacy names are here because a flagged row is by definition one the
 *  migration could not project, so it may still be carrying them;
 *  `mainSession` joined them when the trading window moved onto the
 *  playbook's `config.session`, where no save can touch it. What an operator
 *  can still change about *when* is the pause list. */
const SESSION_PARAM_KEYS = [
  "pauseWindows",
  "mainSession",
  "activeStart",
  "activeEnd",
  "additionalSessions",
] as const;

function sessionConfigChanged(
  before: DeploymentGroup["paramValues"],
  after: DeploymentGroup["paramValues"] | undefined,
): boolean {
  if (after == null) return false;
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  // `deepEqual`, not `JSON.stringify`: key order is not a change. The two
  // blobs reach here from different constructors — one parsed out of SQLite,
  // one assembled by the editor from schema defaults — and a false positive
  // retires a safety banner nobody answered.
  return SESSION_PARAM_KEYS.some((k) => !deepEqual(a[k] ?? null, b[k] ?? null));
}

/**
 * Edit the parent row — **and clear the legs' `pending_reconciliation` when
 * the save touches session config.**
 *
 * That clear used to live in `updateDeployment`, because session config used
 * to live on the leg. It does not any more, and the flag is not dismissable
 * on its own: the session-migration runner sets it, `SessionMigrationBanner`
 * renders it, and the only thing that retires it is the operator fixing the
 * windows. Without a clear on this path the banner is permanent — a safety
 * notice degraded to noise, with no affordance to answer it.
 *
 * The column stays per leg while the config it describes is on the parent,
 * so the clear fans out across every leg of this parent in the same
 * transaction as the parent write. Nothing else is touched: `version` is
 * bumped by `syncLegsFromGroup` on the route, and a status this function
 * does not own must not move.
 */
export function updateGroup(id: string, patch: GroupPatch): DeploymentGroup | null {
  const existing = getGroup(id);
  if (!existing) return null;
  const merged: DeploymentGroup = {
    ...existing,
    ...patch,
    name: "name" in patch ? normalizeName(patch.name ?? null) : existing.name,
    updatedAt: new Date().toISOString(),
  };
  const clearsReconciliation = sessionConfigChanged(existing.paramValues, patch.paramValues);
  const tx = getDb().transaction(() => {
    getDb()
      .prepare(`
        UPDATE deployment_groups
        SET name = ?, param_values = ?, contract_id = ?,
            enabled = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        merged.name,
        JSON.stringify(merged.paramValues),
        merged.contractId,
        merged.enabled ? 1 : 0,
        merged.updatedAt,
        id,
      );
    if (clearsReconciliation) {
      getDb()
        .prepare(`
          UPDATE deployments
          SET pending_reconciliation = NULL
          WHERE group_id = ? AND pending_reconciliation IS NOT NULL
        `)
        .run(id);
    }
  });
  tx();
  return merged;
}

/**
 * Disable a group with snapshot semantics: snapshot whether every active
 * leg was `Active` into `enabled_snapshot`, move the leg out of `Active`,
 * and flip the group flag. Runs in a single SQLite transaction so a partial
 * failure can't leave snapshots written without the group flip.
 *
 * **A leg holding a position goes to `Pausing`, not `Paused`** — D-4 says a
 * deployment that is not Active holds no position, so group disable is a
 * close for those legs and the closing guard finishes the job. `inPosition`
 * is supplied by the caller because this module cannot see engine state or
 * reach a broker; the route that owns the policy gate already knows.
 *
 * Trader rationale: panic-kill is a stress action; on re-enable, restore
 * returns to "exactly the configuration I had pre-kill, minus anything I
 * deliberately changed in between" (manual leg edits during the window
 * also write through to the snapshot — see updateDeployment).
 */
export function disableGroupWithSnapshot(
  id: string,
  inPosition: (leg: Deployment) => boolean = () => false,
): DeploymentGroup | null {
  const group = getGroup(id);
  if (!group) return null;
  if (!group.enabled) return group; // already disabled — idempotent
  const legs = listGroupLegs(id);
  const now = new Date().toISOString();
  const tx = getDb().transaction(() => {
    for (const leg of legs) {
      // Snapshot whether the leg was Active, then take it out of Active.
      // Preserve an existing snapshot (defensive — shouldn't happen when
      // group.enabled=1 was true on entry, but cheap to guard).
      const snapshotVal = leg.enabledSnapshot == null
        ? (leg.status === "Active" ? 1 : 0)
        : (leg.enabledSnapshot ? 1 : 0);
      const nextStatus = closingStatusForDisable(leg, inPosition);
      getDb()
        .prepare(`
          UPDATE deployments
          SET status = ?, enabled = 0, enabled_snapshot = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(nextStatus, snapshotVal, now, leg.id);
    }
    getDb()
      .prepare(`UPDATE deployment_groups SET enabled = 0, updated_at = ? WHERE id = ?`)
      .run(now, id);
  });
  tx();
  log.event(
    "group_state_changed",
    "db",
    `group ${id} disabled with snapshot across ${legs.length} leg(s)`,
  );
  return { ...group, enabled: false, updatedAt: now };
}

/** Where a leg lands when its group turns off. Already-closing legs keep
 *  the status they have — a `Destroying` leg must not be downgraded to
 *  `Pausing`, which would leave the row behind after it went flat. */
function closingStatusForDisable(
  leg: Deployment,
  inPosition: (leg: Deployment) => boolean,
): DeploymentStatus {
  if (leg.status === "Destroying") return "Destroying";
  return inPosition(leg) ? "Pausing" : "Paused";
}

/**
 * Re-enable a group: flip the group flag, restore each leg's status from
 * its `enabled_snapshot`, clear the snapshot column. If a leg has no
 * snapshot (manual disable while group was enabled — shouldn't happen, but
 * defensive) leave its status as-is.
 *
 * A leg still `Destroying` is left alone including its snapshot: the
 * operator asked for that row to go away, and re-enabling its group is not
 * a retraction. A `Pausing` leg is rewritten from its snapshot — `Active` or
 * `Paused` — and its close is dropped either way. No operator route reaches
 * that: the group `PATCH` and both book routes refuse an enable over a
 * `Pausing` leg (`groupEnableWouldRetractClose`) before calling this, so the
 * guard is theirs, not here — a refusal here would leave the reconciler's
 * resume arm skipping silently.
 */
export function enableGroupAndRestore(id: string): DeploymentGroup | null {
  const group = getGroup(id);
  if (!group) return null;
  if (group.enabled) return group; // already enabled — idempotent
  const legs = listGroupLegs(id);
  const now = new Date().toISOString();
  const tx = getDb().transaction(() => {
    for (const leg of legs) {
      if (leg.enabledSnapshot == null) continue;
      if (leg.status === "Destroying") continue;
      const nextStatus = leg.enabledSnapshot ? "Active" : "Paused";
      getDb()
        .prepare(`
          UPDATE deployments
          SET status = ?, enabled = ?, enabled_snapshot = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(nextStatus, leg.enabledSnapshot ? 1 : 0, now, leg.id);
    }
    getDb()
      .prepare(`UPDATE deployment_groups SET enabled = 1, updated_at = ? WHERE id = ?`)
      .run(now, id);
  });
  tx();
  log.event(
    "group_state_changed",
    "db",
    `group ${id} re-enabled, restored ${legs.length} leg(s) from snapshot`,
  );
  return { ...group, enabled: true, updatedAt: now };
}

/**
 * Soft-delete a group: stamps `deleted_at`, force-disables, soft-deletes
 * every leg in the group. Called *after* the route-level
 * `legHasOpenPosition` precheck passes — this function does not block
 * on positions; the route owns that policy gate.
 *
 * Per-leg `enabled` is snapshotted into `enabled_snapshot` (same shape
 * as `disableGroupWithSnapshot`) so a future restore-from-Trash path
 * can rehydrate the original toggle state. Restore isn't implemented
 * in this branch, but writing the snapshot now means the data lands
 * correctly without a follow-up migration.
 */
export function softDeleteGroup(id: string): DeploymentGroup | null {
  const group = getGroup(id);
  if (!group) return null;
  if (group.deletedAt != null) return group; // idempotent
  const legs = listGroupLegs(id);
  const now = new Date().toISOString();
  const tx = getDb().transaction(() => {
    for (const leg of legs) {
      // Preserve any pre-existing snapshot (group was disabled with
      // snapshot, then soft-deleted before re-enable) — that snapshot
      // already reflects the trader's intended state. Otherwise capture
      // whether the leg was `Active`.
      const snapshotVal = leg.enabledSnapshot == null
        ? (leg.status === "Active" ? 1 : 0)
        : (leg.enabledSnapshot ? 1 : 0);
      // The route gates this on every leg being flat, so `Paused` is a
      // confirmed state here rather than an assumption — see the doc
      // comment above.
      getDb()
        .prepare(`
          UPDATE deployments
          SET deleted_at = ?, status = 'Paused', enabled = 0, enabled_snapshot = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(now, snapshotVal, now, leg.id);
    }
    getDb()
      .prepare(`
        UPDATE deployment_groups
        SET deleted_at = ?, enabled = 0, updated_at = ?
        WHERE id = ?
      `)
      .run(now, now, id);
  });
  tx();
  log.event(
    "group_state_changed",
    "db",
    `group ${id} soft-deleted along with ${legs.length} leg(s)`,
  );
  return { ...group, enabled: false, deletedAt: now, updatedAt: now };
}

/**
 * Destroy a group some of whose legs hold a position: per-leg destroy's
 * path, applied to every leg at once. A leg in position goes to
 * `Destroying` (the closing guard flattens and reaps it), a flat leg is
 * soft-deleted now, and the parent is switched off but kept — the engine's
 * last-leg cascade soft-deletes it when the final `Destroying` leg is reaped.
 *
 * `inPosition` is the route's fail-closed `findInPositionLegs` answer, so an
 * unknown reads as in position and gets `Destroying`, never `Paused`. A leg
 * already `Destroying` keeps it whatever the predicate says. A group with no
 * leg in position takes `softDeleteGroup` instead; this is not called for one.
 */
export function beginGroupDestroy(
  id: string,
  inPosition: (leg: Deployment) => boolean,
): DeploymentGroup | null {
  const group = getGroup(id);
  if (!group) return null;
  const legs = listGroupLegs(id);
  const now = new Date().toISOString();
  let destroying = 0;
  const tx = getDb().transaction(() => {
    for (const leg of legs) {
      if (leg.status === "Destroying" || inPosition(leg)) {
        destroying += 1;
        getDb()
          .prepare(`UPDATE deployments SET status = 'Destroying', enabled = 0, updated_at = ? WHERE id = ?`)
          .run(now, leg.id);
      } else {
        softDeleteDeployment(leg.id);
      }
    }
    getDb()
      .prepare(`UPDATE deployment_groups SET enabled = 0, updated_at = ? WHERE id = ?`)
      .run(now, id);
  });
  tx();
  log.event(
    "group_state_changed",
    "db",
    `group ${id} destroying: ${destroying} leg(s) closing first, ${legs.length - destroying} deleted now`,
  );
  return { ...group, enabled: false, updatedAt: now };
}

/**
 * Total non-deleted leg count for a group. Single SQL hit so the
 * Discord embed footer doesn't pull all legs to render
 * `Group: "name" · {account_name} of {total}`.
 */
export function getGroupLegTotal(groupId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM deployments WHERE group_id = ? AND deleted_at IS NULL`)
    .get(groupId) as { n: number };
  return row.n;
}

/**
 * Bump every leg's `version` after a config edit on the parent.
 *
 * **It no longer copies anything.** It used to mirror the parent's
 * `paramValues` onto each leg row, which is the reconciliation params-on-
 * the-parent deletes: a leg reads its parent's blob at query time, so
 * there is nothing to push. What survives is the version bump, which is
 * stamped on every trade at entry so analytics can flag a trade fired
 * against a since-edited config — and that is per leg because the trade
 * row is.
 */
export function syncLegsFromGroup(group: DeploymentGroup): void {
  for (const leg of listGroupLegs(group.id)) {
    updateDeployment(leg.id, {});
  }
}

function normalizeName(name: string | null): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}
