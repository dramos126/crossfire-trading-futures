"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { IntentBadges } from "@/components/intent-badges";
import { PulseDot } from "@/components/pulse-dot";
import {
  DEPLOYMENT_STATUS_LABELS_COMPACT,
  statusToneClass,
} from "@/components/deployment/deployment-status";
import { formatUsd, legPulse, pnlToneClass } from "@/components/board/board-view";
import { useBoardModel } from "@/components/board/use-board";
import { DetachedRecovery } from "@/components/board/detached-recovery";
import {
  CHIPS_DIFFER_BY_ACCOUNT,
  DETAIL_MISSING,
  DETAIL_UNAVAILABLE,
  deploymentIdentity,
  describeLegCaveat,
  describeTruncation,
  formatWinRate,
  historyStats,
  presentDeploymentDetail,
  resolveDeployment,
  selectLegs,
  STATS_UNREADABLE,
} from "@/components/deployment/deployment-detail-model";
import { DeploymentTradeTable } from "@/components/deployment/deployment-trade-table";
import { BROKEN_ROW_EDIT_REASON } from "@/components/board/board-model";
import type { BoardDeployment, BoardLeg } from "@/components/board/board-model";
import { useDeployments } from "@/lib/hooks/use-strategies";
import { useTrades } from "@/lib/hooks/use-trades";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { useDisplayPrivacy, type DisplayPrivacy } from "@/components/privacy/privacy-provider";
import { TIMEFRAME_LABELS } from "@/lib/trading/domain";
import type { StrategyTrade } from "@/lib/db/trade-types";

/**
 * One deployment's history and long-lived stats — `/deployments/[id]`.
 *
 * **This is where all-time money lives, and it is the only place it does.**
 * The board is the session and carries no all-time figure anywhere; that
 * split is the reason this route exists. Nothing here reads
 * `BoardDeployment.sessionPnl`.
 *
 * **One page per deployment, with a per-account filter, and a leg gets no
 * route of its own.** A leg owns an account, a status and its trades and
 * little else, so a page per leg would be mostly empty and would split one
 * deployment's history across three URLs. A link built from a leg still works:
 * `resolveDeployment` maps it to its card and preselects that account.
 *
 * **It renders `BoardDeployment` and reads no `Deployment` or
 * `DeploymentGroup` to draw a field** — the board's Hard rule, which applies
 * to anything rendering board data. The one raw-row read on this page is the
 * export's, which hands a `Deployment` to `exportDeploymentTradesAsJson`; that
 * is a serialization of the row, not a render of a field, and it is called
 * out where it happens.
 *
 * Every decision that could be wrong lives in
 * [`deployment-detail-model.ts`](./deployment-detail-model.ts).
 */

const FIELD_LABEL = "text-[10px] uppercase tracking-wider text-[var(--muted)]";

export function DeploymentDetail({
  id,
  initialAccountId,
}: {
  id: string;
  /** From `?account=`, so a link can land on one leg of a group. */
  initialAccountId: number | null;
}) {
  const trading = useTrading();
  const { board, deploymentsLoadState } = useBoardModel();

  const found = useMemo(() => resolveDeployment(board, id), [board, id]);
  const shown = presentDeploymentDetail({
    connection: trading.status,
    deployments: deploymentsLoadState,
    found,
  });

  return (
    <div className="space-y-4">
      <Link
        href="/"
        className="-ml-3 inline-flex items-center gap-1.5 rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-[var(--muted)] transition-colors hover:border-[var(--card-border)] hover:bg-[var(--bg-row)] hover:text-[var(--foreground)]"
      >
        <svg
          aria-hidden
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        <span>Dashboard</span>
      </Link>

      {shown.warning && (
        <div
          role="alert"
          className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2 text-[11px] leading-snug text-[var(--danger)]"
        >
          {shown.warning}
        </div>
      )}

      {shown.body.kind === "deployment" && (
        // **Keyed on the question, not just the card.** The account selection
        // is `useState` seeded from the URL, and a seed does not re-seed: a
        // second `▸` press from the board — a different leg of the *same*
        // group — changes the href and lands on a component that keeps the
        // first leg's selection, silently answering about the wrong account.
        // Remounting is right rather than merely convenient, because the
        // pagination and the open chart are answers to the old question too.
        <DeploymentBody
          key={`${shown.body.found.card.id}:${initialAccountId ?? shown.body.found.accountId ?? "all"}`}
          card={shown.body.found.card}
          initialAccountId={initialAccountId ?? shown.body.found.accountId}
        />
      )}

      {shown.body.kind === "loading" && (
        <div className="border border-[var(--card-border)] bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          Loading deployment…
        </div>
      )}

      {shown.body.kind === "missing" && (
        <div className="border border-[var(--card-border)] bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          {DETAIL_MISSING}{" "}
          <Link href="/" className="text-[var(--accent)] hover:underline">
            Back to the Dashboard
          </Link>
        </div>
      )}

      {shown.body.kind === "unavailable" && (
        <div className="border border-[var(--danger)]/40 bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          {DETAIL_UNAVAILABLE}
        </div>
      )}
    </div>
  );
}

// ── The deployment ──────────────────────────────────────────────────────

function DeploymentBody({
  card,
  initialAccountId,
}: {
  card: BoardDeployment;
  initialAccountId: number | null;
}) {
  const trading = useTrading();
  const { accountLabel, text } = useDisplayPrivacy();
  const { deployments } = useDeployments();
  const [pickedAccountId, setPickedAccountId] = useState<number | null>(initialAccountId);

  const selection = selectLegs(card, pickedAccountId);
  // A fresh array per render, deliberately unmemoized: `useTrades` sorts and
  // joins it to a string before anything reaches a dependency array, so the
  // subscription keys off the *set* rather than off this reference.
  const { trades, summary, loading, refresh } = useTrades({
    deploymentIds: selection.legs.map((l) => l.id),
  });
  const stats = historyStats(summary);
  const identity = deploymentIdentity(card, selection.legs);

  const timeframeLabel =
    card.timeframe != null
      ? TIMEFRAME_LABELS[card.timeframe as keyof typeof TIMEFRAME_LABELS] ?? card.timeframe
      : null;

  // Masked here once, so the trade table's account column inherits it.
  const accountNameFor = (deploymentId: string): string => {
    const leg = card.legs.find((l) => l.id === deploymentId);
    return leg ? accountLabel(leg.accountName) : `Deployment ${deploymentId}`;
  };
  // The drill-in never groups by book, so the name is the deployment's own —
  // never an account's — and only an account named inside it is masked.
  const title = text(card.name);

  /**
   * The one raw-row read on this page, and it is not a render.
   * `exportDeploymentTradesAsJson` serializes the deployment's own
   * configuration alongside its trades, which is the row itself rather than a
   * field drawn from it. It is available only when exactly one leg is in
   * scope: the file names one account's configuration and cannot speak for
   * three.
   */
  const exportLeg = useMemo(() => {
    if (selection.legs.length !== 1) return null;
    const leg = selection.legs[0];
    const row = deployments.find((d) => d.id === leg.id);
    return row
      ? { deployment: row, accountName: leg.accountName, session: card.sessionWindow }
      : null;
  }, [selection.legs, deployments, card.sessionWindow]);

  const liveUnrealizedFor = (t: StrategyTrade): number | null => {
    if (!t.contractId) return null;
    const position = trading.positions.find(
      (p) => p.accountId === t.accountId && p.contractId === t.contractId,
    );
    return position ? trading.unrealizedForPosition(position) : null;
  };

  const caveats = selection.legs
    .map((leg) => ({ leg, caveat: describeLegCaveat(leg) }))
    .filter((x): x is { leg: BoardLeg; caveat: string } => x.caveat != null);

  return (
    <>
      <header className="border border-[var(--card-border)] bg-[var(--card)] px-4 py-3">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-tight" title={title}>
            {title}
          </h1>
          {/* `legs.length > 1`, not `target.kind` — the reading that survives
              the model change collapsing every target to `deployment`. */}
          {card.legs.length > 1 && (
            <span
              className="shrink-0 rounded-sm border border-[var(--accent)]/30 bg-[var(--accent)]/15 px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--accent)]"
              title={`One deployment across ${card.legs.length} accounts`}
            >
              GRP
            </span>
          )}
          {/* `ml-auto` sits on the rail, not on its first child, so hiding
              Logs cannot un-anchor Edit. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Follows the account filter rather than the whole card: the page
                is showing these legs, so the log it links to is these legs'.
                `?deployment=` repeats, and the value is the id the engine
                stamps on a line — one per leg under today's shape.

                Hidden on an empty selection rather than linked to `/logs?`,
                which scopes to nothing and therefore falls through to the
                whole stream with no banner saying so — a filter silently
                inverted into its opposite. */}
            {selection.legs.length > 0 && (
              <Link
                href={`/logs?${selection.legs
                  .map((l) => `deployment=${encodeURIComponent(l.id)}`)
                  .join("&")}`}
                title="Engine log for the accounts in scope"
                className="shrink-0 rounded-md border border-[var(--card-border)] px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--foreground)]"
              >
                Logs
              </Link>
            )}
            {/* Inert on a card whose parent row is gone — the editor
                resolves a leg up to that parent, so the link returned
                silently. Same reason string as the board's ✎. */}
            {card.editHref == null ? (
              <span
                title={BROKEN_ROW_EDIT_REASON}
                aria-disabled
                className="shrink-0 cursor-not-allowed rounded-md border border-[var(--card-border)] px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)] opacity-40"
              >
                Edit
              </span>
            ) : (
              <Link
                href={card.editHref}
                className="shrink-0 rounded-md border border-[var(--card-border)] px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--foreground)]"
              >
                Edit
              </Link>
            )}
          </div>
        </div>

        <p className="mt-1 flex items-center gap-2 truncate font-mono text-[11px] text-[var(--muted)]">
          <span className="truncate">
            {card.strategyKey}
            {" · "}
            {card.ticker}
            {timeframeLabel && ` · ${timeframeLabel}`}
            {card.sessionWindow && (
              <span title={`Session window in ${card.sessionWindow.timezone}`}>
                {` · ${card.sessionWindow.start}–${card.sessionWindow.end}`}
              </span>
            )}
          </span>
          <IntentBadges intent={card.intent} />
        </p>

        {/* The identity subline — the chip vocabulary the deleted deployment
            card carried. It refuses to print one leg's configuration over a
            deployment header when the legs disagree; the filter below is how
            the operator gets an answer instead.
            **Mono is the chip vocabulary's, not the sentence that replaces
            it** — and a full sentence does not get `truncate` either. */}
        {identity.chips ? (
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-[var(--muted-secondary)]"
            title={identity.chips}
          >
            {identity.chips}
          </p>
        ) : identity.differsByAccount ? (
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted-secondary)]">
            {CHIPS_DIFFER_BY_ACCOUNT}
          </p>
        ) : null}
      </header>

      <StatsStrip stats={stats} loading={loading} scope={scopeLabel(card, selection, accountLabel)} />

      {card.legs.length > 1 && (
        <LegPicker card={card} selectedAccountId={selection.accountId} onPick={setPickedAccountId} />
      )}

      {/* The board's recovery band, under the caveat it explains: the reason
          in words and `Restore and arm`, one component on both surfaces. */}
      {caveats.map(({ leg, caveat }) => (
        <div key={leg.id} className="border border-[var(--warning)]/40">
          <div
            role="status"
            className="bg-[var(--warning)]/10 px-4 py-2 text-[11px] leading-snug text-[var(--warning)]"
          >
            <span className="font-mono">{accountLabel(leg.accountName)}</span> — {caveat}
          </div>
          {leg.detached && (
            <DetachedRecovery leg={leg} bookId={card.bookId} onRestored={() => void refresh()} />
          )}
        </div>
      ))}

      <DeploymentTradeTable
        trades={trades}
        accountNameFor={accountNameFor}
        showAccount={selection.legs.length > 1}
        liveUnrealizedFor={liveUnrealizedFor}
        token={trading.token}
        onDeleted={() => void refresh()}
        exportLeg={exportLeg}
        truncationNote={describeTruncation({ summary, loadedCount: trades.length })}
        serverCounts={{ open: summary?.openTrades ?? null, closed: summary?.closedTrades ?? null }}
        scopeKey={String(selection.accountId ?? "all")}
      />
    </>
  );
}

// ── The stats strip ─────────────────────────────────────────────────────

/** Whose numbers these are — the selected account, or every one of them. */
function scopeLabel(
  card: BoardDeployment,
  selection: ReturnType<typeof selectLegs>,
  accountLabel: DisplayPrivacy["accountLabel"],
): string {
  if (selection.accountId != null) return selection.legs[0] ? accountLabel(selection.legs[0].accountName) : "";
  if (card.legs.length > 1) return "All accounts";
  return card.legs[0] ? accountLabel(card.legs[0].accountName) : "";
}

const FEES_NOTE = "Fees on closed trades. All-Time P&L is already net of them.";

/**
 * The long-lived numbers, all of them off the server's own aggregate.
 *
 * Nothing here is a client-side rollup over the trade list beside it: that
 * list is capped and the aggregate is not, so a win rate counted here would
 * describe a different set of trades than the closed count printed next to
 * it. One reducer per surface.
 *
 * **A summary that has not arrived renders an ellipsis, not a zero** — the
 * board's em-dash rule, in the loading direction. `—` is reserved for a
 * reading that will not arrive, **and it carries its reason**: the arm was
 * unreachable until `useTrades` learned to end the first wait on a fetch that
 * did not answer, so a permanently failing read used to tell the operator to
 * keep waiting.
 */
function StatsStrip({
  stats,
  loading,
  scope,
}: {
  stats: ReturnType<typeof historyStats>;
  loading: boolean;
  scope: string;
}) {
  const blank = loading ? "…" : "—";
  // An em-dash with no reason is a bug report waiting to be filed — copy.md.
  const blankTitle = stats || loading ? undefined : STATS_UNREADABLE;
  return (
    <section
      className="flex flex-wrap items-center gap-x-8 gap-y-2 border border-[var(--card-border)] bg-[var(--card)] px-4 py-2.5"
      aria-label="All-time totals"
    >
      <Figure
        label="All-Time P&L"
        tone={stats ? pnlToneClass(stats.totalPnl) : undefined}
        title={blankTitle}
      >
        {stats ? formatUsd(stats.totalPnl) : blank}
      </Figure>
      <SmallFigure label="Closed" title={blankTitle}>
        {stats ? stats.closed : blank}
      </SmallFigure>
      <SmallFigure label="W / L" title={blankTitle}>
        {stats ? `${stats.wins} / ${stats.losses}` : blank}
      </SmallFigure>
      <SmallFigure label="Win Rate" title={blankTitle}>
        {stats ? formatWinRate(stats.winRate) : blank}
      </SmallFigure>
      <SmallFigure label="Fees" title={stats ? FEES_NOTE : blankTitle}>
        {stats ? formatUsd(-stats.fees) : blank}
      </SmallFigure>
      <SmallFigure label="Open" title={blankTitle}>
        {stats ? stats.open : blank}
      </SmallFigure>
      <span className={`${FIELD_LABEL} ml-auto truncate`} title={scope}>
        {scope}
      </span>
    </section>
  );
}

function Figure({
  label,
  tone,
  title,
  children,
}: {
  label: string;
  tone?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2" title={title}>
      <span className={FIELD_LABEL}>{label}</span>
      <span className={`tabular font-mono text-lg font-semibold ${tone ?? "text-[var(--foreground)]"}`}>
        {children}
      </span>
    </div>
  );
}

function SmallFigure({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2" title={title}>
      <span className={FIELD_LABEL}>{label}</span>
      <span className="tabular font-mono text-xs text-[var(--foreground)]">{children}</span>
    </div>
  );
}

// ── The per-account filter, which is also the leg list ──────────────────

/**
 * The legs, and the filter, as one control.
 *
 * A separate filter bar above a table of the same legs would be two controls
 * for one question. The row *is* the filter: it says what configuration
 * produced the trades below and selecting it scopes them.
 *
 * The status chip and the pulse come from the shared ladder and `legPulse` —
 * **green claims the engine will take an entry here**, which is why the dot's
 * input is `autoTradeRefused` and not `armed`.
 *
 * **The rows are radios, and they say so.** `aria-selected` is only honoured
 * on a row inside a `grid`/`treegrid`, so on a plain `<tr>` assistive tech
 * dropped it and the control announced as an unlabelled table of clickable
 * rows. `role="radiogroup"` on the body with `role="radio"` + `aria-checked`
 * per row is what it actually is: one choice, exactly one selected. Every
 * option stays individually tabbable rather than taking a roving tabindex,
 * because arrow-key navigation is an interaction pattern this surface has not
 * decided on.
 */
function LegPicker({
  card,
  selectedAccountId,
  onPick,
}: {
  card: BoardDeployment;
  selectedAccountId: number | null;
  onPick: (accountId: number | null) => void;
}) {
  const { accountLabel, text } = useDisplayPrivacy();
  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)]" aria-label="Accounts">
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="border-b border-[var(--card-border)] text-left text-[10px] uppercase tracking-wider text-[var(--muted)]">
            <th className="w-9 px-3 py-2 font-medium">
              <span className="sr-only">Filter</span>
            </th>
            <th className="w-[16rem] px-3 py-2 font-medium">Account</th>
            <th className="w-[9rem] px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Configuration</th>
          </tr>
        </thead>
        <tbody>
          <PickerRow
            zebra="bg-[var(--bg-row)]"
            label="All accounts"
            selected={selectedAccountId == null}
            onPick={() => onPick(null)}
          >
            <td className="px-3 py-1.5 font-mono text-[var(--foreground)]">All accounts</td>
            <td className="px-3 py-1.5 text-[var(--muted-secondary)]">
              {card.legs.length} accounts
            </td>
            <td className="px-3 py-1.5 text-[var(--muted-secondary)]">
              Every account&apos;s trades, together
            </td>
          </PickerRow>
          {card.legs.map((leg, i) => {
            const pulse = legPulse(leg);
            return (
              <PickerRow
                key={leg.id}
                zebra={i % 2 === 0 ? "bg-[var(--bg-row-alt)]" : "bg-[var(--bg-row)]"}
                label={accountLabel(leg.accountName)}
                selected={selectedAccountId === leg.accountId}
                onPick={() => onPick(leg.accountId)}
              >
                <td
                  className="truncate px-3 py-1.5 font-mono text-[var(--foreground)]"
                  title={accountLabel(leg.accountName)}
                >
                  {accountLabel(leg.accountName)}
                </td>
                <td className="px-3 py-1.5">
                  <span className="inline-flex items-center gap-2">
                    <span
                      title={leg.chip.reason == null ? undefined : text(leg.chip.reason)}
                      className={`rounded-sm border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusToneClass(leg.chip.tone)}`}
                    >
                      {DEPLOYMENT_STATUS_LABELS_COMPACT[leg.chip.kind]}
                    </span>
                    <PulseDot
                      active={pulse !== "idle"}
                      color={pulse === "running" ? "bg-[var(--success)]" : "bg-[var(--warning)]"}
                    />
                  </span>
                </td>
                <td className="truncate px-3 py-1.5 font-mono text-[var(--muted)]" title={leg.chips}>
                  {leg.chips}
                </td>
              </PickerRow>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * One choice in the scope filter, drawn as a table row.
 *
 * **The control is a real `<input type="radio">` in a cell, not a role on the
 * `<tr>`.** Both halves of that matter. `aria-selected` on a plain row is a
 * no-op — a screen reader only honours it inside `grid`/`treegrid` — so the
 * first attempt at this announced nothing. But overriding the row to
 * `role="radio"` trades one bug for two: `table` may only own rows and
 * rowgroups, so a `radiogroup` inside it makes the table rowless, and `radio`
 * is *children-presentational*, which flattens all three `<td>`s into the
 * control's name and takes the Account/Status/Configuration headers with it.
 *
 * A native input in a shared `name` group is also the only version that keeps
 * the promise the role makes: an operator who hears "radio, 2 of 4" will press
 * an arrow key, and the platform implements roving tabindex and arrow
 * navigation for free. Declaring the role and hand-rolling neither is the half
 * a pattern that is worse than none.
 */
function PickerRow({
  zebra,
  label,
  selected,
  onPick,
  children,
}: {
  zebra: string;
  label: string;
  selected: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <tr
      onClick={onPick}
      className={`cursor-pointer border-b border-l-[3px] border-[var(--card-border)] transition-colors last:border-b-0 hover:bg-[var(--hover)] ${zebra} ${
        selected ? "border-l-[var(--accent)]" : "border-l-transparent"
      }`}
    >
      <td className="px-3 py-1.5">
        <input
          type="radio"
          name="deployment-scope"
          checked={selected}
          onChange={onPick}
          aria-label={label}
          className="cursor-pointer accent-[var(--accent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        />
      </td>
      {children}
    </tr>
  );
}
