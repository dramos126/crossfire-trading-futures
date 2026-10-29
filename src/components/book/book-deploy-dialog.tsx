"use client";

import { useState } from "react";
import {
  deployAccountRows,
  deployBookIntent,
  deployFitWarnings,
  CANCEL_LABEL,
  DEPLOY_BOOK_LABEL,
  DEPLOY_CONFIRM,
  DEPLOY_PICK_ACCOUNT,
  DEPLOY_PICK_BOOK,
  DEPLOY_SUMMARY_LABEL,
  DEPLOY_TITLE,
  type BookCard as BookCardModel,
} from "@/components/book/book-grid-model";
import {
  BookDialog,
  DIALOG_LABEL,
  PickList,
  PlaybookChips,
  PRIMARY_BUTTON,
  refusedStampClass,
  SECONDARY_BUTTON,
  WARN_STAMP,
} from "@/components/book/book-controls";
import {
  describeNoAccounts,
  pickDeployAccount,
  type DeployAccountRow,
} from "@/components/playbook/playbook-deploy-model";
import type { BookPayload, CodeBookPayload } from "@/app/api/books/route";
import { AUTO_BRACKET_STAMP } from "@/lib/trading/broker-access/account-state-gate";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";

/**
 * The Deploy dialog: pick a book (each with its playbooks as chips), pick an
 * account, read what will be on, then *Deploy*. Every refused account is
 * shown greyed with its stamp and the route's own sentence — the live-account
 * block and the account-state gate through the Playbook Deploy picker's rows,
 * and an account that already runs a book through `deployAccountRows` — and
 * the press repeats the disable (`deployBookIntent`). It posts the existing
 * `POST /api/books/deploy`; the book lands switched off, so nothing starts.
 */

export interface DeployDialogProps {
  /** The books in code, as the page's sections hold them. */
  cards: readonly BookCardModel[];
  /** The picker's rows over every account, before the on-a-book refusal. */
  accounts: readonly DeployAccountRow[];
  /** `GET /api/books`' account books, or null before the first read. */
  books: readonly BookPayload[] | null;
  codeBooks: readonly CodeBookPayload[];
  budgetUsd: (accountId: number) => number | null;
  /** The book the empty card's link opened the dialog on. */
  initialBook: string | null;
  busy: boolean;
  /** A broker whose live fetch failed, so its accounts are missing from the
   *  list below — the Dashboard's sentence, verbatim, or null when every
   *  broker answered. */
  catalogWarning: string | null;
  /** The deploy route's refusal, verbatim, when the press was refused. */
  refusal: string | null;
  /** Resolves true once the book is on the account. */
  onDeploy: (bookKey: string, accountId: number) => Promise<boolean>;
  onClose: () => void;
}

export function DeployDialog({
  cards,
  accounts,
  books,
  codeBooks,
  budgetUsd,
  initialBook,
  busy,
  catalogWarning,
  refusal,
  onDeploy,
  onClose,
}: DeployDialogProps) {
  const { text } = useDisplayPrivacy();
  const [bookKey, setBookKey] = useState<string | null>(initialBook);
  const [accountId, setAccountId] = useState<number | null>(null);
  const card = cards.find((c) => c.key === bookKey) ?? null;
  const rows = deployAccountRows(accounts, books, codeBooks, card?.name ?? null);
  const account = rows.find((r) => r.id === accountId) ?? null;
  const intent = deployBookIntent(bookKey, account);

  const press = async () => {
    const now = deployBookIntent(bookKey, account);
    if (now.kind !== "write") return;
    if (await onDeploy(now.book, now.accountId)) onClose();
  };

  return (
    <BookDialog
      title={DEPLOY_BOOK_LABEL}
      busy={busy}
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>
            {CANCEL_LABEL}
          </button>
          <button
            type="button"
            title={DEPLOY_TITLE}
            disabled={busy || intent.kind !== "write"}
            onClick={() => void press()}
            className={PRIMARY_BUTTON}
          >
            {DEPLOY_CONFIRM}
          </button>
        </>
      }
    >
      <div>
        <p className={DIALOG_LABEL}>{DEPLOY_PICK_BOOK}</p>
        <PickList
          name="deploy-book"
          value={bookKey}
          onPick={setBookKey}
          options={cards.flatMap((c) =>
            c.key == null
              ? []
              : [
                  {
                    value: c.key,
                    disabled: false,
                    content: (
                      <span className="block space-y-1.5">
                        <span className="block text-sm font-semibold text-[var(--foreground)]">{c.name}</span>
                        <PlaybookChips contracts={c.contracts} />
                      </span>
                    ),
                  },
                ],
          )}
        />
      </div>

      <div>
        <p className={DIALOG_LABEL}>{DEPLOY_PICK_ACCOUNT}</p>
        {catalogWarning != null && (
          <p role="alert" className="mb-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-[11px] leading-snug text-[var(--warning)]">
            {catalogWarning}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-[11px] text-[var(--muted)]">{books == null ? "…" : describeNoAccounts(false)}</p>
        ) : (
          <PickList
            name="deploy-account"
            value={accountId}
            onPick={(id) => setAccountId(pickDeployAccount(rows, id) ?? accountId)}
            options={rows.map((r) => ({
              value: r.id,
              disabled: r.refusal != null,
              title: r.refusal != null ? text(r.refusal) : (r.warning ?? undefined),
              content: <AccountOption row={r} />,
            }))}
          />
        )}
      </div>

      {card != null && account != null && account.refusal == null && (
        <div>
          <p className={DIALOG_LABEL}>{DEPLOY_SUMMARY_LABEL}</p>
          <div className="space-y-2 rounded-md border border-[var(--card-border)] px-3 py-2">
            <PlaybookChips contracts={card.contracts} />
            {deployFitWarnings(card, budgetUsd(account.id)).map((f) => (
              <p key={f.name} className="text-[11px] leading-snug text-[var(--warning)]">
                <span className="font-semibold">{f.name}:</span> {f.text}
              </p>
            ))}
            {account.warning != null && (
              <p className="text-[11px] leading-snug text-[var(--warning)]">{account.warning}</p>
            )}
            <p className="text-[11px] leading-snug text-[var(--muted)]">{DEPLOY_TITLE}</p>
          </div>
        </div>
      )}

      {refusal != null && (
        <p className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
          {refusal}
        </p>
      )}
    </BookDialog>
  );
}

/** An account row: the account in monospace, its stamp, and a refused row's sentence. */
function AccountOption({ row }: { row: DeployAccountRow }) {
  const { accountLabel, text } = useDisplayPrivacy();
  return (
    <span className="block">
      <span className="flex flex-wrap items-center gap-2">
        <span
          className={`font-mono tabular text-xs ${row.refusal != null ? "text-[var(--muted-secondary)]" : "text-[var(--foreground)]"}`}
        >
          {accountLabel(row.name)}
        </span>
        {row.stamp != null && (
          <span className={refusedStampClass(row.stampFromStateGate)}>{row.stamp}</span>
        )}
        {row.refusal == null && row.warning != null && <span className={WARN_STAMP}>{AUTO_BRACKET_STAMP}</span>}
      </span>
      {row.refusal != null && (
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--muted-secondary)]">{text(row.refusal)}</span>
      )}
    </span>
  );
}
