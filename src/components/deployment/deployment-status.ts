/**
 * The deployment status ladder — one derivation, every surface that
 * renders a per-deployment state chip.
 *
 * Three components rendered their own copy of this ladder and none of
 * them had a rung for the live-account block, so a deployment the engine
 * had refused to run rendered as "Flat" — armed and waiting. The block's
 * output reached exactly one surface (the post-deploy held-back strip),
 * and only on the one code path that kept `syncEngine`'s response.
 *
 * The fix derives the refusal from state rather than threading the
 * response: the input is the server's own verdict, carried on each
 * `/api/accounts` row (`AccountRow.autoTrade`), so the ladder never
 * recomputes the policy (bugs.md A38). A deployment whose account is
 * missing from the catalogue takes `accountAutoTrade(null)`, the
 * fail-closed `UNVERIFIED_ACCOUNT_REFUSAL` — see `account-trading-policy.ts`.
 */

import type { AutoTradeVerdict } from "@/lib/trading/broker-access/account-trading-policy";
import type { TradeStatus } from "@/lib/db/trade-types";
import type { DeploymentStatus } from "@/lib/trading/domain";
import { PLAYBOOK_NOT_IN_BUILD } from "@/lib/trading/strategies/prod-playbooks";

export type DeploymentStatusKind =
  | "detached"
  | "pausing"
  | "destroying"
  | "paused"
  | "no-auto-trade"
  | "not-in-build"
  | "disconnected"
  | "pending-entry"
  | "pending-exit"
  | "in-position"
  | "armed-setup"
  | "setup-blocked"
  | "flat";

export type DeploymentStatusTone = "active" | "warn" | "danger" | "muted";

/** The rendered chip, not the row's lifecycle status — that is
 *  `DeploymentStatus` in `trading/domain.ts` and is one of this ladder's
 *  inputs. Named apart so the two never get confused at a call site. */
export interface DeploymentStatusChip {
  kind: DeploymentStatusKind;
  tone: DeploymentStatusTone;
  /**
   * The surface's tooltip, verbatim: the account policy's refusal on
   * `no-auto-trade`, `PLAYBOOK_NOT_IN_BUILD` on `not-in-build`, the
   * playbook's own setup note on `armed-setup`, that note plus the holder on
   * `setup-blocked`, absent on every other rung.
   * Never re-worded per surface — ui/copy.md rule 4.
   */
  reason?: string;
}

export interface DeploymentStatusInput {
  /** The account vanished from the broker; the Detached tab's variant. */
  detached?: boolean;
  /** The row's lifecycle status. `Pausing` and `Destroying` are closing
   *  states the engine drives, and they get their own rungs — a closing
   *  deployment is neither running nor settled, and saying "Paused" while a
   *  position is still open is the exact lie D-4 exists to prevent. */
  status: DeploymentStatus;
  /**
   * The server's auto-trade verdict for the deployment's account —
   * `accountAutoTrade(row)`, which refuses an account the catalogue has no
   * row for.
   */
  autoTrade: AutoTradeVerdict;
  /**
   * Dashboard stream health. Only `false` produces `disconnected`, so a
   * surface with no disconnected state omits it rather than passing a
   * lie.
   */
  live?: boolean;
  /**
   * Whether this build registers the row's playbook. Only `false` produces
   * `not-in-build`, for `live`'s reason: a surface that cannot ask omits it.
   */
  playbookInBuild?: boolean;
  openTradeStatus?: TradeStatus | null;
  hasLivePosition: boolean;
  /**
   * The engine's setup reading for this leg — the playbook's one-sentence
   * note — or null/absent when it is not armed **or the reading was not had**
   * (no stream, a failed read). Only a non-empty note produces `armed-setup`,
   * and only where the ladder would otherwise answer `flat`: absence claims
   * nothing.
   */
  setupNote?: string | null;
}

/** Full-width labels — the deployment card. */
export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatusKind, string> = {
  detached: "Detached",
  pausing: "Pausing",
  destroying: "Deleting",
  paused: "Paused",
  "no-auto-trade": "No Auto-Trade",
  "not-in-build": "Not in Build",
  disconnected: "Disconnected",
  "pending-entry": "Pending Entry",
  "pending-exit": "Pending Exit",
  "in-position": "In Position",
  "armed-setup": "Armed",
  "setup-blocked": "Blocked",
  flat: "Flat",
};

/**
 * Abbreviated labels for the single-line leg row, which has a fixed
 * account column to clear. `no-auto-trade` is deliberately *not*
 * abbreviated: it is the same rule wearing the same words as the
 * `no auto-trade` stamp on a refused picker row.
 */
export const DEPLOYMENT_STATUS_LABELS_COMPACT: Record<DeploymentStatusKind, string> = {
  ...DEPLOYMENT_STATUS_LABELS,
  "pending-entry": "Pending",
  "pending-exit": "Exiting",
  "in-position": "In Pos",
};

/**
 * Tone → pill classes. Lives here rather than beside each chip so a new
 * surface cannot introduce a fifth tone by writing its own map.
 *
 * All four cases go through tokens. The `warn` case was raw Tailwind
 * (`yellow-500` / `yellow-300`) — carried over verbatim from the two chips
 * this replaced and flagged in the design language as a known violation of
 * the colour rule. It took `--warning` when the board landed, which is the
 * same Tailwind-400 weight as its three siblings and shifts the rendered
 * colour from `#FDE047` to `#FBBF24`: marginally deeper, less acid.
 *
 * **Not a new amber token.** `--amber-bg` / `--amber-border` / `--amber-text`
 * belong to the non-prod env chrome, which is page-level where this is
 * row-level, and two amber vocabularies at two scales is the confusion this
 * reuse avoids.
 */
export function statusToneClass(tone: DeploymentStatusTone): string {
  switch (tone) {
    case "active":
      return "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/30";
    case "warn":
      return "bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30";
    case "danger":
      return "bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30";
    case "muted":
      return "bg-[var(--bg)] text-[var(--muted)] border-[var(--card-border)]";
  }
}

/**
 * Order is a correctness property, not a style one:
 *
 * 1. `detached` first — the account is gone, so it is absent from the
 *    catalogue, so the verdict below it would be `UNVERIFIED` for every
 *    detached row. Putting the refusal above this rung would stamp every
 *    Detached card with a "reload the dashboard" instruction that fixes
 *    nothing.
 * 2. `pausing` / `destroying` next, then `paused` — all three are the
 *    operator's own action, and the block is moot until they resume. A row
 *    that reads as refused when the operator is looking at their own pause
 *    hides their own action. The two closing rungs sit above `paused`
 *    rather than folding into it because they are the one case where the
 *    deployment is off *and* a position may still be open: rendering that
 *    as "Paused" is the promise D-4 exists to keep, made early.
 * 3. `no-auto-trade` here, and everything below it describes a
 *    deployment the engine has accepted and is running. A withheld row is
 *    not in that set, so any rung below would be a claim about an engine
 *    relationship that does not exist — including `in-position`, where
 *    the bracket is running on the broker's side with the engine no
 *    longer managing the exit. The header's `U:` cluster and the expanded
 *    position summary still render, so an open position stays visible.
 * 4. `not-in-build` directly under it, for the same reason: a row whose
 *    playbook this build does not register takes no entry and has nothing
 *    managing its position, so no rung below may describe it. Under the
 *    account refusal rather than over it because that one is the policy the
 *    platform must never be seen to drop.
 * 5. `armed-setup` is `flat` with a reason: the last rung's only refinement,
 *    so it can never outrank anything. Named apart from `BoardLeg.armed`,
 *    which is the engine's entry gate and not a setup. `setup-blocked` is
 *    never answered here: it needs the other rows on the account, so
 *    `buildBoard` turns an `armed-setup` into it (see `blockArmedSetups`).
 */
export function deriveDeploymentStatus(input: DeploymentStatusInput): DeploymentStatusChip {
  if (input.detached) return { kind: "detached", tone: "danger" };
  if (input.status === "Pausing") return { kind: "pausing", tone: "warn" };
  if (input.status === "Destroying") return { kind: "destroying", tone: "warn" };
  if (input.status !== "Active") return { kind: "paused", tone: "muted" };

  const verdict = input.autoTrade;
  if (!verdict.permitted) {
    return { kind: "no-auto-trade", tone: "danger", reason: verdict.reason };
  }
  if (input.playbookInBuild === false) {
    return { kind: "not-in-build", tone: "danger", reason: PLAYBOOK_NOT_IN_BUILD };
  }

  if (input.live === false) return { kind: "disconnected", tone: "danger" };
  if (input.openTradeStatus === "pending_entry") return { kind: "pending-entry", tone: "warn" };
  if (input.openTradeStatus === "pending_exit") return { kind: "pending-exit", tone: "warn" };
  if (input.hasLivePosition) return { kind: "in-position", tone: "active" };
  const note = input.setupNote?.trim();
  if (note) return { kind: "armed-setup", tone: "warn", reason: note };
  return { kind: "flat", tone: "muted" };
}
