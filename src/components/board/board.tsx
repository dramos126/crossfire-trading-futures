"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { BoardCard } from "@/components/board/board-card";
import { BoardUnmanagedPositions } from "@/components/board/board-unmanaged";
import { SessionMigrationBanner } from "@/components/session-migration-banner";
import { FlattenAllButton } from "@/components/flatten-all-button";
import {
  BOARD_ALL_SWITCHED_OFF,
  BOARD_TOTALS_UNAVAILABLE,
  boardVisibility,
  describeHiddenBooks,
  describeHiddenPlaybooks,
  HIDDEN_BOOKS_DETAIL,
  HIDDEN_PLAYBOOKS_DETAIL,
  HIDDEN_BOOKS_LINK_LABEL,
  formatUsd,
  pnlToneClass,
  presentBoard,
  TOTAL_UNPRICED,
} from "@/components/board/board-view";
import { useBoardModel } from "@/components/board/use-board";
import { ViewControls } from "@/components/privacy/view-controls";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * The Dashboard board — what is running, this session, and the controls to
 * act on it.
 *
 * Every component here renders `BoardDeployment` and never a `Deployment` or
 * a `DeploymentGroup`. That is the Hard rule in
 * [design-language.md](../../docs/modules/ui/design-language.md) — a card
 * that reaches back for a *field it is about to draw* re-creates the
 * two-shape rendering the build order exists to delete.
 *
 * **The inputs are assembled in [`use-board.ts`](./use-board.ts)**, which
 * this file held until the drill-in became the adapter's second consumer.
 * `board-card.tsx` calls the lifecycle *writes* — `toggleDeployment` /
 * `deleteDeployment` and `PATCH` / `DELETE /api/groups/[id]` — routed by
 * `target.kind`, because the adapter has already decided which surface the
 * card is and fanning those through here would put the discriminator back in
 * the component the adapter took it out of. `resyncEngine` there folds the
 * raw cache for one whole-list question. Neither is a read of a row for
 * render.
 *
 * Money is session-scoped everywhere and there is no all-time figure on this
 * page at all. The strip's total comes from `allAccounts()` and its count
 * from `openPositionCount()`; **neither is a fold of the cards**, because
 * summing `sessionPnl.total` double-counts unrealized wherever two cards map
 * to one broker position and `BoardDeployment.openPositionCount` counts legs
 * rather than positions.
 */

const FIELD_LABEL = "text-[10px] uppercase tracking-wider text-[var(--muted)]";

const STRIP_FIGURE = "font-mono tabular text-lg font-semibold";

/**
 * One display-tier figure on the session strip, with the em-dash it renders
 * when the board could not read what the figure is made of.
 *
 * **`readable` is `presentBoard`'s answer, not a local one.** The strip's
 * two numbers reduce over `visibleAccounts`, which is empty on an error and
 * on a session that has not connected — and an empty reduction is a
 * structurally valid `$0.00` / `0`, indistinguishable from a genuinely flat
 * session. That is exactly the defect `boardSessionPnl` fixes for the cards,
 * and the rule that the money and the open count go blind *together* is why
 * one flag drives both.
 */
function StripFigure({
  label,
  readable,
  reason = BOARD_TOTALS_UNAVAILABLE,
  tone,
  children,
}: {
  label: string;
  readable: boolean;
  /** The em-dash's tooltip, when it is not the board-wide one. */
  reason?: string;
  /** Sign colour, for the figure that carries one. */
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={FIELD_LABEL}>{label}</span>
      {readable ? (
        <span className={`${STRIP_FIGURE} ${tone ?? "text-[var(--foreground)]"}`}>{children}</span>
      ) : (
        <span
          className={`${STRIP_FIGURE} text-[var(--muted)] cursor-help`}
          title={reason}
        >
          —
        </span>
      )}
    </div>
  );
}

/**
 * A filter's count and the screen that holds what it hid. It reports a filter,
 * not a state: no box, no chip, no tone.
 */
function HiddenCountLine({ text, detail }: { text: string; detail: string }) {
  return (
    <div className="px-4 font-mono tabular text-[11px] text-[var(--muted)]">
      <span className="cursor-help" title={detail}>
        {text}
      </span>
      {" · "}
      <Link href="/books" className="text-[var(--accent)] hover:underline">
        {HIDDEN_BOOKS_LINK_LABEL}
      </Link>
    </div>
  );
}

export function Board() {
  const trading = useTrading();
  // **The board is books.** A row a book materialised groups with its
  // siblings into one card per `(account, ticker)`; a hand-made deployment
  // keeps its own grouping beside it. The drill-in and the editor take the
  // default, because their page is one deployment's.
  const { board, refreshGroups, deploymentsLoadState, livePnl } = useBoardModel({
    groupByBook: true,
  });
  const [reconnecting, setReconnecting] = useState(false);
  /** The cards drawn open. Every card starts folded onto its header; nothing is persisted. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  const token = trading.token;

  // A switched-off book's card, and a book card's row of a playbook that is
  // off, are left out, never deleted — and counted, so a line can say so. Only
  // the card list reads `cards`: the strip above reads the live-P&L hook and
  // the unmanaged strip reads the whole board, so neither can lose a figure to
  // anything hidden.
  const { cards, hiddenBookCount, hiddenPlaybookCount } = boardVisibility(board);
  const hiddenBooks = describeHiddenBooks(hiddenBookCount);

  const shown = presentBoard({
    connection: trading.status,
    deployments: deploymentsLoadState,
    cardCount: cards.length,
    hiddenBookCount,
  });

  const foldable = shown.body.kind === "cards" ? cards.map((c) => c.id) : [];
  const allOpen = foldable.length > 0 && foldable.every((id) => expanded.has(id));

  const total = livePnl.allAccounts();
  const openPositions = livePnl.openPositionCount();

  const retry = useCallback(async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await trading.connect();
    } finally {
      setReconnecting(false);
    }
  }, [reconnecting, trading]);

  return (
    <div className="space-y-4">
      {/* ── Session strip ── */}
      <section
        className="flex flex-wrap sm:flex-nowrap items-center gap-x-8 gap-y-2 px-4 py-2.5 rounded-lg border border-[var(--card-border)] bg-[var(--card)]"
        aria-label="Session totals"
      >
        {/* Both figures go blind together, and on the same predicate the
            body is gated on — the reduce behind them is over
            `visibleAccounts`, which is empty on an error and on a session
            that has not connected yet. An empty reduction is a
            structurally valid zero, so this is the em-dash rule the cards
            below already keep, one component higher. */}
        {/* An unpriced open position blanks the money and not the count:
            the count is known, the total is not (A68). */}
        {total.total == null ? (
          <StripFigure
            label="Session P&L"
            readable={false}
            reason={shown.totalsReadable ? TOTAL_UNPRICED : BOARD_TOTALS_UNAVAILABLE}
          >
            {null}
          </StripFigure>
        ) : (
          <StripFigure label="Session P&L" readable={shown.totalsReadable} tone={pnlToneClass(total.total)}>
            {formatUsd(total.total)}
          </StripFigure>
        )}
        <StripFigure label="Open" readable={shown.totalsReadable}>
          {openPositions}
        </StripFigure>
        {/* On a phone this is the strip's second row, Flatten all filling
            what the cluster leaves; from `sm` it sits right on the one row. */}
        <div className="ml-auto flex items-center gap-2 basis-full sm:basis-auto">
          <ViewControls
            fold={
              foldable.length > 0
                ? { allOpen, onToggle: () => setExpanded(allOpen ? new Set() : new Set(foldable)) }
                : undefined
            }
          />
          <FlattenAllButton token={token} />
        </div>
      </section>

      {shown.warning && (
        <div
          role="alert"
          className="px-4 py-2 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)] text-[11px] leading-snug flex items-center gap-3"
        >
          <span className="flex-1">{shown.warning}</span>
          <button
            type="button"
            onClick={retry}
            disabled={reconnecting}
            className="px-2.5 py-1 rounded-sm text-[11px] uppercase tracking-wider border border-[var(--danger)]/40 hover:bg-[var(--danger)]/15 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {reconnecting ? "Reconnecting…" : "Retry"}
          </button>
        </div>
      )}

      {/* A partial account catalogue. `/api/accounts` answers 200 with a soft
          error field when one broker fails, so without a renderer this is a
          silent outage — and on this board it is worse than silent: a Topstep
          account missing from the catalogue has no row and so no server
          verdict, which the client reads as refused (A38), so every leg on it
          chips `No Auto-Trade`. The screen would say the
          platform is refusing to trade when the truth is a broker is down.
          `brokers/README.md` states the render rule; the picker used to be
          where it landed. */}
      {trading.accountCatalogWarning && (
        <div
          role="alert"
          className="px-4 py-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)] text-[11px] leading-snug"
        >
          {trading.accountCatalogWarning}
        </div>
      )}

      {/* Boot's session-migration results: rows it disabled and flagged, and
          position-holding rows it could not migrate. Deployment-scoped, so
          the board is its home now that the Deployments page is gone —
          without it the operator never learns boot turned something off. */}
      <SessionMigrationBanner />

      <BoardUnmanagedPositions board={board} />

      {/* The hidden-playbooks line hugs its own card, because each book card
          is one account and the count is that account's. */}
      {shown.body.kind === "cards" &&
        cards.map((card) => {
          const hiddenPlaybooks = describeHiddenPlaybooks(hiddenPlaybookCount.get(card.id) ?? 0);
          return (
            <div key={card.id} className="space-y-1">
              <BoardCard
                card={card}
                onMutated={refreshGroups}
                expanded={expanded.has(card.id)}
                onToggleExpanded={toggleExpanded}
              />
              {hiddenPlaybooks && (
                <HiddenCountLine text={hiddenPlaybooks} detail={HIDDEN_PLAYBOOKS_DETAIL} />
              )}
            </div>
          );
        })}

      {shown.body.kind === "all-off" && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          {BOARD_ALL_SWITCHED_OFF}
        </div>
      )}

      {/* Not over a board that cannot vouch for itself: the count is of rows
          that loaded, and the banner above is already the thing to read. */}
      {hiddenBooks && (shown.body.kind === "cards" || shown.body.kind === "all-off") && (
        <HiddenCountLine text={hiddenBooks} detail={HIDDEN_BOOKS_DETAIL} />
      )}

      {shown.body.kind === "loading" && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-6 text-center text-[var(--muted)] text-xs">
          Loading deployments…
        </div>
      )}

      {shown.body.kind === "empty" && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          Nothing is deployed. Open a playbook on{" "}
          <Link href="/playbooks" className="text-[var(--accent)] hover:underline">
            Playbooks
          </Link>{" "}
          to put one on an account.
        </div>
      )}

      {shown.body.kind === "unavailable" && (
        <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--card)] px-4 py-6 text-center text-xs text-[var(--muted)]">
          The board cannot say what is running.
        </div>
      )}
    </div>
  );
}
