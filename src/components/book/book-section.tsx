"use client";

import { useState } from "react";
import {
  deployBookToLabel,
  describeBookHeading,
  BOOK_NO_ACCOUNTS,
  WHATS_IN_BOOK_LABEL,
  type BookCard as BookCardModel,
} from "@/components/book/book-grid-model";
import { LINK_BUTTON, PlaybookChips } from "@/components/book/book-controls";
import { AccountCard, type AccountCardProps } from "@/components/book/book-account-card";

/**
 * One book's section: its name and counts as the heading, then a card per
 * account running it. The playbook list is not drawn at section level — the
 * account cards are the list — except behind *What's in this book*, and on the
 * empty card of a book no account runs, which is where its definition is
 * drawn and where *Deploy <book> to an account* opens the Deploy dialog on it.
 *
 * The section of accounts not on a book has no definition and no deploy, and
 * says why its accounts are there.
 */

export interface BookSectionProps {
  card: BookCardModel;
  busy: boolean;
  /** Opens the Deploy dialog with this book picked. */
  onDeploy: (bookKey: string) => void;
  /** Everything each account card takes but its row and whether it is open. */
  account: Omit<AccountCardProps, "row" | "expanded">;
  /** The ids of the account cards drawn open; the rest fold onto their header. */
  expanded: ReadonlySet<string>;
}

export function BookSection({ card, busy, onDeploy, account, expanded }: BookSectionProps) {
  const [open, setOpen] = useState(false);
  const unbooked = card.key == null;
  const empty = card.accounts.length === 0;
  return (
    <section aria-label={card.name} className="space-y-2">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <h2 className="text-lg font-semibold tracking-tight text-[var(--foreground)]">{card.name}</h2>
        {!unbooked && <p className="text-xs text-[var(--muted)]">{describeBookHeading(card)}</p>}
        {!unbooked && !empty && (
          <>
            {/* Below sm the control drops to its own line, left-aligned. */}
            <span aria-hidden className="basis-full sm:hidden" />
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className={`sm:ml-auto ${LINK_BUTTON}`}
            >
              {WHATS_IN_BOOK_LABEL}
            </button>
          </>
        )}
      </header>
      {card.note != null && <p className="max-w-3xl px-1 text-[11px] leading-snug text-[var(--muted)]">{card.note}</p>}
      {open && !empty && (
        <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-3">
          <PlaybookChips contracts={card.contracts} />
        </div>
      )}
      {empty && !unbooked ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-dashed border-[var(--card-border)] px-4 py-4">
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm text-[var(--muted)]">{BOOK_NO_ACCOUNTS}</p>
            <PlaybookChips contracts={card.contracts} />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => card.key != null && onDeploy(card.key)}
            className={`ml-auto ${LINK_BUTTON}`}
          >
            {deployBookToLabel(card.name)}
          </button>
        </div>
      ) : (
        card.accounts.map((row) => (
          <AccountCard key={row.id} row={row} expanded={expanded.has(row.id)} {...account} />
        ))
      )}
    </section>
  );
}
