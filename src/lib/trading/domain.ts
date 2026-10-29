/**
 * The app's own vocabulary — strategy config, timeframes, the curated
 * ticker list, and the deployment / group rows. None of it crosses a
 * broker wire; the broker-facing shapes live in `@/lib/brokers/types`.
 */

// ── Trading Strategies ──────────────────────────────────────────────

export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  "1m": "1 Minute",
  "3m": "3 Minutes",
  "5m": "5 Minutes",
  "15m": "15 Minutes",
  "30m": "30 Minutes",
  "1h": "1 Hour",
  "4h": "4 Hours",
  "1d": "1 Day",
};

export type IndicatorType =
  | "EMA"
  | "SMA"
  | "RSI"
  | "MACD"
  | "BOLL"
  | "ATR"
  | "VWAP"
  | "SESSION_VWAP"
  | "SESSION_VWAP_BANDS"
  | "VOL"
  | "ADX";

export const INDICATOR_LABELS: Record<IndicatorType, string> = {
  EMA: "EMA",
  SMA: "SMA",
  RSI: "RSI",
  MACD: "MACD",
  BOLL: "Bollinger Bands",
  ATR: "ATR",
  VWAP: "VWAP",
  SESSION_VWAP: "Session VWAP",
  SESSION_VWAP_BANDS: "Session VWAP bands",
  VOL: "Volume",
  ADX: "ADX",
};

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  params: Record<string, number>;
}

// ── Deployments (strategy + ticker + account) ──────────────────────

export type TickerSymbol =
  | "/ES" | "/NQ" | "/YM" | "/RTY" | "/GC" | "/SI" | "/CL" | "/NG"
  | "/MES" | "/MNQ" | "/MYM" | "/M2K" | "/MGC" | "/SIL" | "/MCL" | "/MNG";

export type TickerCategory = "mini" | "micro";

export const TICKER_OPTIONS: { symbol: TickerSymbol; name: string; exchange: string; category: TickerCategory }[] = [
  { symbol: "/ES", name: "E-mini S&P 500", exchange: "CME", category: "mini" },
  { symbol: "/NQ", name: "E-mini Nasdaq 100", exchange: "CME", category: "mini" },
  { symbol: "/YM", name: "E-mini Dow", exchange: "CBOT", category: "mini" },
  { symbol: "/RTY", name: "E-mini Russell 2000", exchange: "CME", category: "mini" },
  { symbol: "/GC", name: "Gold", exchange: "COMEX", category: "mini" },
  { symbol: "/SI", name: "Silver", exchange: "COMEX", category: "mini" },
  { symbol: "/CL", name: "Crude Oil", exchange: "NYMEX", category: "mini" },
  { symbol: "/NG", name: "Natural Gas", exchange: "NYMEX", category: "mini" },
  { symbol: "/MES", name: "Micro E-mini S&P 500", exchange: "CME", category: "micro" },
  { symbol: "/MNQ", name: "Micro E-mini Nasdaq 100", exchange: "CME", category: "micro" },
  { symbol: "/MYM", name: "Micro E-mini Dow", exchange: "CBOT", category: "micro" },
  { symbol: "/M2K", name: "Micro E-mini Russell 2000", exchange: "CME", category: "micro" },
  { symbol: "/MGC", name: "Micro Gold", exchange: "COMEX", category: "micro" },
  { symbol: "/SIL", name: "Micro Silver", exchange: "COMEX", category: "micro" },
  { symbol: "/MCL", name: "Micro Crude Oil", exchange: "NYMEX", category: "micro" },
  { symbol: "/MNG", name: "Micro Natural Gas", exchange: "NYMEX", category: "micro" },
];

/**
 * Deployment lifecycle status — D-1 / D-4 / D-5 of
 * [position-lifecycle](../../../docs/proposals/position-lifecycle.md).
 *
 * | status | meaning |
 * |---|---|
 * | `Active` | the engine manages it |
 * | `Pausing` | closing; on confirmed flat → `Paused` |
 * | `Paused` | the engine does not manage it, **and it is flat** |
 * | `Destroying` | closing; on confirmed flat → row reaped |
 *
 * Three the operator chooses (Active / Paused / Destroy), two the system
 * passes through. **Both transient states are conditional** — a deployment
 * with no open position pauses or destroys immediately and never enters
 * one, so they are the minority path.
 */
export type DeploymentStatus = "Active" | "Pausing" | "Paused" | "Destroying";

/**
 * *Removing the final leg is refused, not a delete* — the one sentence
 * every surface that states it uses.
 *
 * Three of them now say it: `remove-leg`'s 409, the editor's pinned
 * checkbox, and the per-account `−` on the strategy page. It is one
 * exported constant for the reason `LIVE_ACCOUNT_REFUSAL` is — a refusal
 * that reasons differently at the tooltip than at the error the same action
 * produces teaches the operator to trust neither. It names the remedy
 * because this refusal has one; see [ui/copy.md](../../../docs/modules/ui/copy.md).
 */
export const LAST_LEG_REFUSAL =
  "A deployment runs on at least one account. To remove this one, delete the deployment.";

/**
 * *A deployment a book materialised is stood down from the book grid, not
 * deleted here* — the one sentence every surface that states it uses.
 *
 * `DELETE /api/groups/[id]` 409s with it, and any surface rendering `✕` on a
 * derived row owes it in the `title` of a disabled control. One constant for
 * the reason `LAST_LEG_REFUSAL` is. It names the control because this refusal clears the
 * moment the operator uses it — see
 * [ui/copy.md](../../../docs/modules/ui/copy.md) — and it says why deleting is
 * not the shorter path: the reconciler would create the row again.
 */
export const BOOK_DERIVED_ROW_REFUSAL =
  "This deployment belongs to a book, so the book grid's playbook toggle is what turns it off. " +
  "Deleting it here would leave it to be created again at the next reconcile.";

/**
 * *A detached row that is still closing keeps its close* — the sentence
 * `POST /api/deployments/[id]/clear-orphan` 409s with and the board's
 * recovery band renders on a control it has disabled.
 *
 * `markOrphaned` preserves `Pausing` / `Destroying` on purpose — the close is
 * owed whether or not the account answers — so a row can be detached
 * mid-close, and `clearOrphanedAndReEnable` writes `status = 'Active',
 * enabled = 1` unconditionally. Restoring one would retract the operator's own
 * Destroy, drop it out of `listClosingDeployments()` and re-arm entries with
 * the position still open, which is the rule under the status table in
 * [deployments.md](../../../docs/modules/trading/deployments.md). One constant
 * for the reason `BOOK_DERIVED_ROW_REFUSAL` is.
 */
export const RESTORE_WOULD_RETRACT_A_CLOSE =
  "This deployment is closing a position and still owes that close. " +
  "Restoring it now would retract the close and re-arm it with the position open — wait for the close to finish.";

/**
 * *Resuming a hand-made deployment waits for a close still in flight* — the
 * sentence `PATCH /api/deployments/[id]` (`status: "Active"` on a
 * `Pausing`/`Destroying` leg) and `PATCH /api/groups/[id]` (an enable over a
 * leg {@link groupEnableWouldRetractClose} names) 409 with, and the board's
 * inert card and leg `▶` carry as their `title` (`cardToggleIntent`,
 * `legToggleIntent`).
 *
 * Either write retracts the close the operator asked for — the group's
 * through `enableGroupAndRestore`, which rewrites a `Pausing` leg from its
 * snapshot — and re-arms entries with the position open. One constant for the
 * reason `BOOK_DERIVED_ROW_REFUSAL` is; it names no control, because the
 * remedy is waiting.
 */
export const RESUME_WOULD_RETRACT_A_CLOSE =
  "This deployment is closing a position. Resuming now would cancel a close that is already on its way — wait for it to finish.";

/**
 * *A leg still closing stays on the account it is closing on* — the sentence
 * `PATCH /api/deployments/[id]` 409s with when a body moves a `Pausing` /
 * `Destroying` leg to another account.
 *
 * The closing guard flattens whatever account the row names when it next
 * runs, so a move sends the close to the new account: the old account's
 * position is never closed, and a position on the new one that belongs to
 * someone else can be. Names no control, because the remedy is waiting.
 */
export const MOVE_WOULD_MISDIRECT_A_CLOSE =
  "This deployment is closing a position on its current account. Moving it to another account now would send that close to the other account instead — wait for the close to finish.";

/**
 * *Only a settled `Paused` leg moves accounts* — the sentence the same 409
 * carries for an `Active` leg, which has no close in flight to name but may
 * hold a position the move would strand on the old account.
 */
export const MOVE_NEEDS_A_PAUSED_LEG =
  "Only a paused deployment can be moved to another account. Pause it and let it settle first.";

/**
 * *A book's detached row under a switched-off playbook is turned back on in
 * the book first* — the sentence `POST /api/deployments/[id]/clear-orphan`
 * 409s with and the board's recovery band renders on the control it disables.
 *
 * `clearOrphanedAndReEnable` writes the leg `Active` and never touches
 * `deployment_groups.enabled`, so under a disabled parent the leg would not
 * trade and would still hold its own `(account, ticker, playbook)` slot —
 * every book control on the cell then refuses, with nothing left to undo it
 * (bugs.md A85). Off-and-on in the book enables the parent through the
 * reconciler, which is the first move this names. It spells the recovery
 * control's label, `DETACHED_RECOVER_LABEL`, because that constant lives in
 * a component this module may not import; a test pins the two together.
 */
export const RESTORE_NEEDS_PLAYBOOK_ON =
  "This playbook is switched off in its book, so restoring this deployment now would leave it switched off " +
  "and lock the playbook on this account. On Books, turn the playbook off and on again first, then use Restore and arm.";

/**
 * *Turning a book or one of its playbooks on waits for a close still in
 * flight* — the sentence `PATCH /api/books/[id]`,
 * `PATCH /api/books/[id]/playbooks` and *Move to <book>* (`"move"`, for the
 * playbooks the new book resumes) 409
 * with, and the book grid's inert switch and cell carry as their `title`.
 *
 * The resume is `enableGroupAndRestore`, which rewrites a `Pausing` leg from
 * its snapshot and drops the close it owed. A builder rather than a constant
 * because a book switch can resume several playbooks and the operator's next
 * question is which one (copy.md, 2026-09-09). Like
 * `RESTORE_WOULD_RETRACT_A_CLOSE` it names no control: the remedy is waiting.
 */
export function turnOnWouldRetractACloseRefusal(
  playbookNames: readonly string[],
  switched: "book" | "playbook" | "move",
): string {
  const names =
    playbookNames.length <= 2
      ? playbookNames.join(" and ")
      : `${playbookNames.slice(0, -1).join(", ")} and ${playbookNames[playbookNames.length - 1]}`;
  const press =
    switched === "book"
      ? "Turning the book on"
      : switched === "move"
        ? "Moving this account to that book"
        : "Turning it on";
  return playbookNames.length === 1
    ? `${names} is still closing a position on this account and owes that close. ` +
        `${press} now would retract the close and re-arm it with the position open — wait for the close to finish.`
    : `${names} are still closing positions on this account and owe those closes. ` +
        `${press} now would retract the closes and re-arm them with the positions open — wait for the closes to finish.`;
}

/** The statuses a client may ask for. `Pausing` / `Destroying` are the
 *  engine's to write; Destroy is a DELETE, not a status assignment. */
export const OPERATOR_DEPLOYMENT_STATUSES = ["Active", "Paused"] as const;
export type OperatorDeploymentStatus = (typeof OPERATOR_DEPLOYMENT_STATUSES)[number];

export function isOperatorDeploymentStatus(v: unknown): v is OperatorDeploymentStatus {
  return v === "Active" || v === "Paused";
}

/** Parse a persisted or wire value. Anything unrecognised — including a
 *  legacy row the backfill missed — reads as `Paused`, which is the
 *  fail-closed answer: unmanaged and making no claim to be flat-by-us. */
export function parseDeploymentStatus(v: unknown): DeploymentStatus {
  return v === "Active" || v === "Pausing" || v === "Destroying" ? v : "Paused";
}

/** The engine owes this row a flatten before it settles. */
export function isClosingStatus(status: DeploymentStatus): boolean {
  return status === "Pausing" || status === "Destroying";
}

/**
 * Would turning this leg's parent on retract the close it owes? The question
 * every enable-shaped refusal asks — the group `PATCH`, both book routes, and
 * the board card's `▶` — narrower than {@link isClosingStatus} on purpose.
 *
 * `enableGroupAndRestore` rewrites a `Pausing` leg from its snapshot: `Active`
 * resumes it, `Paused` claims it flat, and either drops the close. A
 * `Destroying` leg it skips, so the delete still lands and refusing over one
 * would only strand its siblings behind it. A `Pausing` leg under a disabled
 * parent always carries a snapshot — the disable cascade and a status write
 * under a disabled parent both stamp one — so the status alone answers.
 *
 * Not for a write to the leg itself: `Active` written straight onto a
 * `Destroying` row retracts the delete, which is why the leg route and
 * `clear-orphan` keep `isClosingStatus`.
 */
export function groupEnableWouldRetractClose(status: DeploymentStatus): boolean {
  return status === "Pausing";
}

/** Rows the engine loads and keeps evaluating exits for. `Paused` is the
 *  only status that means "not ours" — under D-4 it also means flat. */
export function isEngineManagedStatus(status: DeploymentStatus): boolean {
  return status !== "Paused";
}

/**
 * **This is a *leg*, not what the operator calls a deployment.**
 *
 * The model since 2026-09-03 is *one deployment, N legs*: the parent owns
 * the name, the strategy, the instrument, the params and the `enabled`
 * switch, and each leg contributes an account and a lifecycle `status`. A
 * single-account deployment is a parent with one leg. (A leg used to
 * contribute a `sizeOverride` too — the one thing that was ever genuinely
 * per leg. The risk sizer deleted it: contract count is the account's
 * posture divided by this entry's stop, which is where "how much may this
 * lose" belonged all along.)
 * The code's two nouns are **inverted** relative to that model — the parent
 * is {@link DeploymentGroup} and its routes are `/api/groups/*` — and the
 * rename is deferred deliberately, not forgotten: `DeploymentStatus`,
 * `DeploymentState`, `getDeployment`, `processDeployment`,
 * `listManagedDeployments`, `strategy_trades.deployment_id`,
 * `useDeployments` and the whole `deployment_*` log-event namespace move
 * with it, and those event names are keyed on exact strings by the
 * escalation registry. All-or-nothing, its own branch, its own review —
 * **do not half-do it**, and read `group` in this codebase as "the parent
 * deployment". See docs/modules/trading/deployments.md's Decisions and the
 * open entry in docs/punchlist.md.
 */
export interface Deployment {
  id: string;
  /** Strategy module key (derived from filename, e.g. "ema-crossover") */
  strategyKey: string;
  accountId: number;
  ticker: TickerSymbol;
  contractId: string | null;
  /** Lifecycle status. Replaced the `enabled` boolean — see
   *  {@link DeploymentStatus}. Entry-eval gates on `Active`; exit-eval
   *  gates on anything but `Paused`. */
  status: DeploymentStatus;
  /** Per-deployment parameter overrides, keyed by param name. Values are
   *  scalars (number/boolean/string) or `{start,end}[]` arrays (the
   *  pause-windows control, plus the legacy multi-window one). **No
   *  timezoned window shape:** the trading window is the playbook's
   *  `config.session` and a deployment carries none. */
  paramValues: Record<
    string,
    number | boolean | string | { start: string; end: string }[]
  >;
  createdAt: string;
  updatedAt: string;
  /** Set when the engine auto-paused this deployment because the account
   *  is no longer accessible (combine→XFA upgrade, expired sim, etc).
   *  Distinct from a user-driven pause (orphanReason stays null). */
  orphanedAt: string | null;
  orphanReason: string | null;
  /** Soft-delete marker. Non-null moves the deployment to the Trash tab;
   *  the row stays so trades remain attached and the user can Recreate
   *  (clones the row's params into a new deployment with a fresh UUID).
   *  "Retire" from the Trash tab sets `tombstonedAt` rather than removing
   *  the row, preserving trade attribution. */
  deletedAt: string | null;
  /** Tombstone marker. Set by the Trash tab's "Retire" action; the row
   *  stays so trades keep referencing a real deployment_id but the engine
   *  excludes it (active queries already filter `deletedAt IS NULL`).
   *  Tombstoned rows surface in the Retired bucket of the All-Time card.
   *  Synthetic tombstones for pre-Track-4 orphans use `(retired deployment)`
   *  as the name. */
  tombstonedAt: string | null;
  /** Monotonic edit counter. Starts at 1, increments on every successful
   *  PATCH. Stamped onto every trade row at entry so the analytics panel
   *  can flag trades fired against a since-edited config. Never resets —
   *  trashed/reactivated deployments keep climbing. */
  version: number;
  /** Optional human label. Null falls back to the strategy's display name
   *  in the UI; explicit values disambiguate copies (e.g. "ORB — NY"). */
  name: string | null;
  /** Text reason set by the session-migration runner when a row's legacy
   *  `additionalSessions` shape couldn't be auto-projected into the new
   *  `mainSession + pauseWindows` model. The banner queries this.
   *
   *  **Cleared by `updateGroup` when the parent's save changes session
   *  config**, fanning out across every leg — the column is per leg and the
   *  config it describes is on the parent. It is not dismissable on its own,
   *  so that clear is the only affordance the operator has for the banner. */
  pendingReconciliation: string | null;
  /** The parent this leg belongs to. **Never null** — every deployment is
   *  a parent with one or more legs, and a single-account deployment is a
   *  parent with one leg. The parent owns the canonical config (size,
   *  mainSession, params, filters); group operations (edit, pause-all,
   *  soft-delete) cascade across every leg sharing it.
   *
   *  A legacy row that predates this shape has a NULL column, and
   *  `rowToDeployment` reads it as **`""`** — the id of no parent, never a
   *  parent that exists. `groupCache.get("")` is undefined, so such a row
   *  takes no entry. Nothing repairs one: the shape change is a wipe, not a
   *  migration (see the model section of `proposals/ui-rework.md`), and a
   *  boot guard counts what is left. **Do not add a `groupId == null` branch
   *  to recover the old shape** — there is one shape, and this field is
   *  non-null so that no consumer is asked to invent a second. */
  groupId: string;
  /** Snapshot of "was this leg `Active`" taken at the moment of group
   *  disable (or the moment the leg's status was edited while the group
   *  was disabled). Restored on group re-enable. Null when not currently
   *  in a group-disabled window. Tracks "intended state" — manual leg
   *  edits during the disabled window also write here so re-enable
   *  preserves trader intent.
   *
   *  Boolean rather than a `DeploymentStatus` on purpose: only `Active`
   *  and `Paused` are ever snapshotted. A leg that is `Pausing` or
   *  `Destroying` when the group is disabled already has an operator
   *  intent of "not Active", so it snapshots false and re-enable leaves
   *  it paused rather than resurrecting a close that was asked for. */
  enabledSnapshot: boolean | null;
}

/**
 * **This is the *deployment* — the thing the operator, every module doc and
 * the UI call by that name.** The runtime type called {@link Deployment} is
 * its leg; the inversion is deliberate and deferred, and the whole of it is
 * on that declaration. Nothing here is a "group of deployments": it is one
 * deployment that runs on N accounts, and a single-account deployment is
 * this row with one leg.
 *
 * It owns the canonical config — params, filter_config, ticker, contract —
 * and each leg carries only its own `accountId` and status.
 * `enabled` is explicit rather than derived from leg state:
 * the operator switching the deployment off is a different fact from "every
 * leg happens to be paused", and `enabledSnapshot` is what restores the
 * difference. Entry-eval reads per-leg `status === "Active"` AND'd with this
 * `enabled`; exit-eval reads leg status alone, because a leg the parent
 * turned off is a leg the engine still owes a flatten.
 */
export interface DeploymentGroup {
  id: string;
  /** Optional human label. Falls back to the strategy display name. */
  name: string | null;
  strategyKey: string;
  /** Canonical config, shared by every leg. Same shape as
   *  `Deployment.paramValues`. **`size` in here no longer reaches an order**
   *  — it is a leftover `CommonParams` key that the backtest and the dev
   *  order tool still read and the engine does not. */
  paramValues: Deployment["paramValues"];
  ticker: TickerSymbol;
  contractId: string | null;
  enabled: boolean;
  /**
   * The book this deployment was materialised by, or `null` for a hand-made
   * one — `deployment_groups.book_id`, the **only** pointer between the two
   * and it points one way.
   *
   * **`null` is the reading every pre-existing row has and it means
   * *hand-made*.** The column takes no default for that reason
   * ([persistence/README.md](../../../docs/modules/persistence/README.md)), and
   * the same asymmetry holds here: a row that carries a book is one the
   * reconciler owns the lifecycle of, and a row that carries none is the
   * operator's own.
   *
   * It is on the domain type rather than left in the row because **the board
   * asks it of every card**: a derived row's `✕` and card `⏸` render inert
   * with {@link BOOK_DERIVED_ROW_REFUSAL}, which the routes answer 409 with,
   * and a surface may not reach past `board-model.ts` to a raw row for a field
   * it is about to draw ([ui/design-language.md](../../../docs/modules/ui/design-language.md)).
   */
  bookId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Soft-delete marker. Sends the group + all legs to Trash; legs cascade
   *  via `legHasOpenPosition` blocks at delete time. */
  deletedAt: string | null;
}
