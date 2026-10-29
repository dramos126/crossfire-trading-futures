/**
 * The drill-in's decisions — everything `/deployments/[id]` answers that is
 * not markup.
 *
 * Fifth module on the `deployment-status.ts` / `trade-markers.ts` /
 * `board-model.ts` / `board-view.ts` pattern, and it exists for the same
 * reason they do: every sentence below renders, compiles, and is wrong in a
 * way nothing catches if it is written inside JSX.
 *
 * **The page is per deployment; the trades are per leg.** That gap is what
 * this file is mostly about. A deployment running on three accounts has one
 * drill-in with a per-account filter, because a leg owns an account, a
 * status and its trades and little else — a page per leg would be mostly
 * empty and would split one deployment's history across three URLs.
 *
 * **Money here is all-time, not session-scoped.** That is the whole reason
 * the route exists: the board is the session and deliberately carries no
 * all-time figure anywhere. Nothing in here reads `BoardDeployment`'s
 * `sessionPnl` — it takes `PnLSummary`, which is a server `SUM` with no
 * window and no limit.
 *
 * **The em-dash rule from `board-model.ts` holds here unchanged.** A zero the
 * surface cannot read is not a reading. The two places it bites on this page
 * are a size the resolver refuses (`Size —` in the chips) and legs that
 * disagree about their own identity, which answers `null` rather than picking
 * a leg's row to speak for the deployment.
 */

import type { BoardDeployment, BoardLeg } from "@/components/board/board-model";
import {
  BOARD_LIST_STALE_WARNING,
  BOARD_STALE_WARNING,
  type ConnectionStatus,
} from "@/components/board/board-view";
import type { PnLSummary } from "@/lib/db/trade-types";
import type { DeploymentsLoadState } from "@/lib/hooks/use-strategies";

// ── Which deployment the URL names ──────────────────────────────────────

/**
 * What `/deployments/[id]` resolved to.
 *
 * `accountId` is the leg the URL landed on, when it named one. A group's legs
 * have ids of their own that are not the card's id, so a link built from a
 * leg — the board's `▸`, a log line, a future Discord alert — has to resolve
 * to the card that holds it rather than 404. Landing on the leg's own account
 * is then the honest default: the operator asked about that account.
 */
export interface ResolvedDeployment {
  card: BoardDeployment;
  /** The account to preselect, or `null` for the all-accounts view. */
  accountId: number | null;
}

/**
 * Find the deployment a URL id names.
 *
 * **Two ids reach this route and only one of them is a card id, and the
 * model change did not collapse that — it widened it.** A card is keyed by
 * the parent row while its legs carry `deployments` row ids, and both are
 * things a link can be built from. A one-leg deployment's card id used to
 * *be* its leg id, so half the links landed on the card arm by coincidence;
 * every one of them now lands on the leg arm and resolves upward. The card
 * lookup still runs first, because a card id is unambiguous.
 *
 * `null` means no live deployment has that id: deleted, tombstoned, or never
 * existed. The page says so rather than rendering an empty shell.
 */
export function resolveDeployment(
  board: readonly BoardDeployment[],
  id: string,
): ResolvedDeployment | null {
  const card = board.find((c) => c.id === id);
  if (card) return { card, accountId: null };
  for (const candidate of board) {
    const leg = candidate.legs.find((l) => l.id === id);
    if (leg) return { card: candidate, accountId: leg.accountId };
  }
  return null;
}

// ── Gone, not yet, and could not say ────────────────────────────────────

/** What goes where the deployment goes. */
export type DetailBody =
  | { kind: "deployment"; found: ResolvedDeployment }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "unavailable" };

export interface DetailPresentation {
  body: DetailBody;
  /** A banner above a deployment that did resolve, when the list behind it
   *  has stopped updating. Null otherwise. */
  warning: string | null;
}

export const DETAIL_MISSING =
  "There is no deployment with this id. It was deleted, or the link is stale.";

export const DETAIL_UNAVAILABLE =
  "The deployment list could not be loaded, so this page cannot say whether this deployment exists. Reconnect or reload before acting on it.";

/**
 * `presentBoard`'s question, asked about one row instead of the list.
 *
 * **`resolveDeployment` answers `null` for three different facts** — deleted,
 * not hydrated yet, and the read failed — exactly as `buildBoard` answers
 * `[]` for three. Rendering the third as *"there is no deployment with this
 * id"* tells the operator their deployment is gone, which is the worse lie:
 * a 401 on a refetch and a `DELETE` that went through look identical from
 * here, and only one of them means anything is over.
 *
 * The two channels are the same two and they still fail independently —
 * `useTrading().status` for the session, `DeploymentsLoadState` for the
 * store — and *missing* is claimed only when **both have answered**, which is
 * the same predicate `presentBoard` gates its `empty` body on.
 *
 * A deployment that *did* resolve renders with a banner rather than being
 * replaced by one, for the reason cards win on the board: a row that loaded
 * is still true of when it loaded. The two stale sentences are `board-view`'s
 * own, because they describe the same two failures — naming the connection
 * over a healthy connection sends the operator to reconnect something that is
 * not broken, here as much as there.
 */
export function presentDeploymentDetail(input: {
  connection: ConnectionStatus;
  deployments: DeploymentsLoadState;
  found: ResolvedDeployment | null;
}): DetailPresentation {
  const connectionBroken = input.connection === "error";
  const listBroken = input.deployments === "failed";
  const answered = input.deployments === "ready" && input.connection === "connected";

  const warning = connectionBroken
    ? BOARD_STALE_WARNING
    : listBroken
      ? BOARD_LIST_STALE_WARNING
      : null;

  if (input.found) return { body: { kind: "deployment", found: input.found }, warning };
  if (connectionBroken || listBroken) return { body: { kind: "unavailable" }, warning: null };
  if (!answered) return { body: { kind: "loading" }, warning: null };
  return { body: { kind: "missing" }, warning: null };
}

// ── The per-account filter ──────────────────────────────────────────────

/**
 * The legs a selection covers, and whether the selection is still real.
 *
 * **A selected account that is no longer a leg falls back to all accounts
 * rather than showing nothing.** Removing a leg while its drill-in is open is
 * an ordinary thing to do from another tab, and an empty page whose filter
 * names an account the deployment does not have reads as a broken query.
 */
export interface LegSelection {
  /** The legs in scope, in the card's own account order. */
  legs: BoardLeg[];
  /** The account actually selected — `null` for all accounts, which is also
   *  what a stale selection degrades to. */
  accountId: number | null;
}

export function selectLegs(card: BoardDeployment, accountId: number | null): LegSelection {
  if (accountId == null) return { legs: card.legs, accountId: null };
  const legs = card.legs.filter((l) => l.accountId === accountId);
  if (legs.length === 0) return { legs: card.legs, accountId: null };
  return { legs, accountId };
}

// ── The identity subline ────────────────────────────────────────────────

/** What the header renders under the title. */
export interface DeploymentIdentity {
  /**
   * `SL:20 · CD: 30s`, prefixed with the strategy key when the deployment
   * carries a custom name.
   *
   * **`null` when the legs disagree.** Nothing on the chip row is per leg
   * today — the `Size` chip was the last thing that could differ and it went
   * with `sizeOverride` — so this is currently unreachable. It stays because
   * printing one leg's row over a deployment header is a specific, checkable
   * claim that would be wrong for every other leg, and the check is what
   * makes the *next* per-leg field safe to add rather than silently
   * misreported.
   */
  chips: string | null;
  /** Whether the legs disagree — the reason `chips` is null, distinguished
   *  from a card with no legs at all. */
  differsByAccount: boolean;
}

export const CHIPS_DIFFER_BY_ACCOUNT =
  "This deployment is configured differently on each account. Pick an account to see its stop and gates.";

/**
 * The identity subline the deleted `deployment-card.tsx` used to render,
 * reconstructed where [design-language.md](../../docs/modules/ui/design-language.md)
 * says it belongs.
 *
 * The chip vocabulary is `formatDeploymentChips`' and the strategy-key prefix
 * rule is unchanged: it appears only when the operator named the deployment,
 * because otherwise the title already is the strategy and the prefix repeats
 * it. `hasCustomName` is the input rather than `name !== strategyKey`, so an
 * operator who names a deployment after its strategy does not silently lose
 * the prefix on a string coincidence.
 */
export function deploymentIdentity(
  card: Pick<BoardDeployment, "strategyKey" | "hasCustomName">,
  legs: readonly Pick<BoardLeg, "chips">[],
): DeploymentIdentity {
  if (legs.length === 0) return { chips: null, differsByAccount: false };
  const first = legs[0].chips;
  if (legs.some((l) => l.chips !== first)) {
    return { chips: null, differsByAccount: true };
  }
  return {
    chips: card.hasCustomName ? `${card.strategyKey} · ${first}` : first,
    differsByAccount: false,
  };
}

// ── The all-time stats ──────────────────────────────────────────────────

/**
 * The long-lived numbers the drill-in exists for.
 *
 * **Every field is derived from `PnLSummary` and nothing else.** That summary
 * is a server aggregate over every row; the trade list beside it is capped at
 * `limit` (200 by default). Mixing them — a win rate counted client-side over
 * the loaded page beside a closed count from the server — is the disagreement
 * [design-language.md](../../docs/modules/ui/design-language.md) records as a
 * React pitfall, and on this page it would be a win rate for a different set
 * of trades than the one it is printed next to. One reducer per surface, and
 * on this surface it is the server's.
 *
 * `winRate` is `null` rather than `0` when nothing has closed: a deployment
 * that has never traded has no win rate, and `0%` says it loses every time.
 */
export interface HistoryStats {
  /** Net of fees — the same semantics as the per-row `pnlDollars`. */
  totalPnl: number;
  fees: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  /** `0`–`1`, over decided trades. `null` when none have closed. */
  winRate: number | null;
}

export function historyStats(summary: PnLSummary | null): HistoryStats | null {
  if (summary == null) return null;
  const decided = summary.winCount + summary.lossCount;
  return {
    totalPnl: summary.totalPnlDollars,
    fees: summary.totalFeesDollars,
    closed: summary.closedTrades,
    open: summary.openTrades,
    wins: summary.winCount,
    losses: summary.lossCount,
    // Scratches — a closed trade at exactly zero — are counted by neither
    // side, so the rate is over decided trades rather than over `closed`.
    // Dividing by `closed` would report a win rate that silently falls as
    // scratches accumulate.
    winRate: decided === 0 ? null : summary.winCount / decided,
  };
}

/** `0.6` → `60%`. Whole percent: the extra digit implies a precision a
 *  40-trade sample does not have. */
export function formatWinRate(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/**
 * The reason the stats strip's em-dashes carry.
 *
 * **An em-dash with no reason is a bug report waiting to be filed** —
 * [copy.md](../../docs/modules/ui/copy.md)'s empty-slot rule — and the arm
 * that renders it was unreachable until `useTrades` learned to end the first
 * wait on a fetch that did not answer. Before that, `loading` stayed true
 * forever on a 401 and the strip told the operator to keep waiting. The
 * sentence names what cannot be read and then what would fix it, in that
 * order.
 */
export const STATS_UNREADABLE =
  "No totals — the trade history could not be read for this deployment. It retries every few seconds; reload the page if the figures do not come back.";

// ── What the table is actually showing ──────────────────────────────────

/**
 * Whether the loaded trade list is all of them.
 *
 * The list endpoint caps at `limit`; the summary does not. A page that
 * paginates 200 rows under a header saying 340 closed is not wrong, but it is
 * only not wrong if it says so — otherwise the last page reads as the end of
 * the deployment's history.
 *
 * `null` when there is nothing to say: the list is complete, or the summary
 * has not arrived to compare against.
 */
export function describeTruncation(args: {
  summary: PnLSummary | null;
  loadedCount: number;
}): string | null {
  const { summary, loadedCount } = args;
  if (summary == null) return null;
  if (summary.totalTrades <= loadedCount) return null;
  return `Showing the most recent ${loadedCount} of ${summary.totalTrades} trades. The totals above cover all of them.`;
}

/**
 * The count a table section bar prints — the server's, and how much of it is
 * on screen.
 *
 * **A section bar folded from the loaded rows is the server-`SUM`-versus-
 * client-rollup pitfall, one heading below the strip that gets it right.**
 * The list is the 200 most recent rows plus every unsettled one (since
 * 2026-10-12), and the summary is not capped at all, so the two can still
 * differ on closed rows. Before that, an open row older than the 200 most
 * recent fell outside the window and the bar read *"No Open Position"* twelve pixels under a strip printing
 * `Open 1`. The server's number is the claim; the loaded number says how many
 * of them are rendered, and the two are shown together rather than one being
 * picked.
 *
 * `total == null` is the summary not having arrived — `…`, *not yet*, which
 * is the same glyph the stats strip uses and for the same reason. It is never
 * a zero, because a bar that says `(0)` while the first poll is out has
 * claimed something.
 */
export function describeSectionCount(args: { total: number | null; shown: number }): string {
  const { total, shown } = args;
  if (total == null) return shown === 0 ? "…" : `(${shown})`;
  // `>=` rather than `===`: the two come from one response and cannot
  // disagree that way today, but a bar printing a total smaller than the rows
  // under it would be the same defect pointing the other way.
  if (shown >= total) return `(${shown})`;
  return `(${shown} of ${total})`;
}

/**
 * An account name split for middle-truncation: a head that may be clipped and
 * a tail that may not.
 *
 * **The end of a Topstep account name is the part that identifies it.**
 * `PRAC-V2-100200-90012114` and `PRAC-V2-100200-90020038` are two legs of one
 * deployment and share their first sixteen characters, so an end-truncating
 * column — which is what `truncate` gives — renders both as `PRAC-V2-100200…`
 * in the view whose entire job is telling them apart. Splitting at the last
 * `-` keeps the discriminator on screen and spends the ellipsis on the prefix
 * the rows have in common.
 *
 * A name with no `-` has no identified suffix, so the whole thing is the head
 * and it truncates the ordinary way.
 */
export function splitAccountName(name: string): { head: string; tail: string } {
  const cut = name.lastIndexOf("-");
  if (cut <= 0) return { head: name, tail: "" };
  return { head: name.slice(0, cut), tail: name.slice(cut) };
}

// ── Legs the page cannot fully speak for ────────────────────────────────

/**
 * The warning a leg's row carries, or `null`.
 *
 * **A detached leg's trades are still its trades.** No live price is put on
 * an open position while it is detached — but the closed rows in
 * `strategy_trades` are durable and their P&L is booked. This page is
 * history, so it renders them; what it must not do is let the row read as an
 * ordinary one. That is the same split `board-model.ts` makes between
 * `sessionPnl` (a live reading, nullable) and the trade rows (durable, always
 * there).
 *
 * **It does not say why the leg is detached.** The recovery band under it
 * does, per reason code; a caveat asserting the account had left the
 * broker's list contradicted that band on every row whose check could not
 * finish (bugs.md A74).
 */
export const DETACHED_LEG_HISTORY =
  "Closed trades below are still this account's; anything still open cannot be priced while it is detached.";

export function describeLegCaveat(leg: Pick<BoardLeg, "detached">): string | null {
  return leg.detached ? DETACHED_LEG_HISTORY : null;
}
