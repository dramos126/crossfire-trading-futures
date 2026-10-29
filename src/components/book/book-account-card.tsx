"use client";

import Link from "next/link";
import {
  bookSwitchIntent,
  cellToggleIntent,
  describeAccountSummary,
  moveToLabel,
  removeBookIntent,
  ACCOUNT_MENU_LABEL,
  BOOK_CELL_NOT_IN_BUILD_STAMP,
  BOOK_NO_PLAYBOOKS,
  BOOK_RISK_LABEL,
  REMOVE_BOOK_LABEL,
  RISK_PAGE_HREF,
  type BookGridCell,
  type BookGridRow,
} from "@/components/book/book-grid-model";
import {
  ActionMenu,
  BookSwitch,
  ACCOUNT_STATE_DANGER_STAMP,
  ContractColumns,
  DANGER_STAMP,
  PlaybookCheckbox,
  RiskCell,
  WARN_STAMP,
  type MenuItem,
} from "@/components/book/book-controls";
import { Chevron } from "@/components/chevron";
import { maskRiskBalance } from "@/components/board/board-view";
import { maskUsdFigures } from "@/components/privacy/privacy-model";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import { NO_AUTO_TRADE_STAMP } from "@/components/playbook/playbook-deploy-model";
import { MoveToReplacement } from "@/components/playbook/playbook-account-gates";
import { AUTO_BRACKET_STAMP } from "@/lib/trading/broker-access/account-state-gate";
import type { TickerSymbol } from "@/lib/trading/domain";

/**
 * One account running a book: its card in the book's section. The account and
 * its status stamps, the summary, its risk, its own switch and ⋯ (*Move to
 * <book>*, *Remove from account*), then its own on/off for each playbook the
 * book carries, in contract columns.
 *
 * **Every control disables from the same intent its press handler refuses
 * on** — `pressCell` / `pressBook` / `pressRemove` below. The guard lives
 * beside the markup for that reason: the render and the write must not be
 * able to disagree about which card is off-limits.
 */

/** The account's cell `PATCH` body: one cell, by contract and playbook. */
export interface CellPatch {
  ticker: TickerSymbol;
  strategyKey: string;
  on: boolean;
}

export interface AccountCardProps {
  row: BookGridRow;
  busy: boolean;
  onToggleBook: (row: BookGridRow, next: { enabled: boolean }) => void;
  onToggleCell: (row: BookGridRow, next: CellPatch) => void;
  /** *Move to replacement* on a dead account's card. Absent renders none. */
  move?: { token: string | null; onMoved: () => void };
  /** *Remove from account* in the ⋯ menu, behind a confirm. Absent draws no item. */
  onRemove?: (row: BookGridRow) => void;
  /** *Move to <book>*: the books it may move to, and the Move dialog it opens on one. */
  moveTo?: {
    targets: ReadonlyArray<{ id: string; name: string }>;
    onOpen: (row: BookGridRow, targetId: string) => void;
  };
  /** Whether the contract columns show. Absent draws them, with no chevron. */
  expanded?: boolean;
  onToggleExpanded?: (row: BookGridRow) => void;
}

/**
 * The press handlers, exported because they are the only place the re-check
 * can be *tested*: React drops a mouse event on a control it rendered
 * `disabled` by reading the props, so stripping the attribute and dispatching
 * proves nothing. The render disables from the intent and the handler refuses
 * from the same intent.
 */
export function pressCell(
  row: BookGridRow,
  cell: BookGridCell,
  onToggle: AccountCardProps["onToggleCell"],
): void {
  const intent = cellToggleIntent(row, cell);
  if (intent.kind !== "write") return;
  onToggle(row, { ticker: intent.ticker, strategyKey: intent.strategyKey, on: intent.on });
}

export function pressBook(row: BookGridRow, onToggle: AccountCardProps["onToggleBook"]): void {
  const intent = bookSwitchIntent(row);
  if (intent.kind !== "write") return;
  onToggle(row, { enabled: intent.enabled });
}

export function pressRemove(row: BookGridRow, onRemove: NonNullable<AccountCardProps["onRemove"]>): void {
  if (removeBookIntent(row).kind !== "write") return;
  onRemove(row);
}

export function AccountCard({
  row,
  busy,
  onToggleBook,
  onToggleCell,
  move,
  onRemove,
  moveTo,
  expanded,
  onToggleExpanded,
}: AccountCardProps) {
  const remove = removeBookIntent(row);
  const collapsible = expanded != null && onToggleExpanded != null && row.refusal == null;
  const open = !collapsible || expanded;
  const { hideAccountIds, hideBalances, accountLabel, text } = useDisplayPrivacy();
  const label = accountLabel(row.title);
  // An account id is a technical value: monospace, head-truncated because the
  // suffix is what tells two accounts apart. Hidden, the alias is whole.
  const accountId = (
    <span className="flex min-w-0 max-w-[26rem] font-mono tabular">
      {hideAccountIds ? (
        <span className="truncate">{label}</span>
      ) : (
        <>
          <span className="truncate">{row.account.head}</span>
          <span className="shrink-0">{row.account.tail}</span>
        </>
      )}
    </span>
  );
  // A `Max Loss` reason states the balance against its floor, and the switch
  // and the cells repeat the reason in their titles. Only that sentence's
  // figures are masked: a cell's title also carries risk figures, which stay.
  const rawReason = row.stateRefusal?.reason ?? null;
  const shield = (s: string) =>
    text(rawReason == null ? s : s.split(rawReason).join(maskUsdFigures(rawReason, hideBalances)));
  const stateReason = rawReason == null ? null : shield(rawReason);
  const items: MenuItem[] = [
    ...(moveTo?.targets ?? []).map(
      (target): MenuItem => ({
        label: moveToLabel(target.name),
        title: moveToLabel(target.name),
        inert: false,
        confirm: false,
        onPress: () => moveTo?.onOpen(row, target.id),
      }),
    ),
    ...(onRemove && remove.kind !== "none"
      ? [
          {
            label: REMOVE_BOOK_LABEL,
            title: remove.title,
            inert: remove.kind === "inert",
            confirm: true,
            onPress: () => pressRemove(row, onRemove),
          },
        ]
      : []),
  ];
  // Drawn twice, one copy per breakpoint: on a phone it is the control the
  // operator comes for, so it sits on the id's line rather than the last one.
  const bookSwitch = (
    <BookSwitch
      enabled={row.enabled}
      title={shield(row.switchTitle)}
      inert={bookSwitchIntent(row).kind === "inert"}
      busy={busy}
      onPress={() => pressBook(row, onToggleBook)}
    />
  );

  return (
    <section aria-label={label} className="rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
      <header
        className={`flex flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3 ${open ? "border-b border-[var(--card-border)]" : ""}`}
      >
        {/* Below sm this block takes the whole row and the cluster after it
            drops under it; the switch is drawn on the id's line instead. */}
        <div className="min-w-0 basis-full sm:flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--foreground)]">
            <span className="flex min-w-0 basis-full items-center gap-2 sm:contents">
              {collapsible ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => onToggleExpanded(row)}
                  className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 hover:bg-[var(--muted)]/10"
                >
                  <Chevron expanded={open} className="shrink-0 text-[var(--muted)]" />
                  {accountId}
                </button>
              ) : (
                accountId
              )}
              <span className="ml-auto shrink-0 sm:hidden">{bookSwitch}</span>
            </span>
            {row.refusal != null && (
              <span title={text(row.refusal)} className={`cursor-help ${DANGER_STAMP}`}>
                {NO_AUTO_TRADE_STAMP}
              </span>
            )}
            {row.stateRefusal != null && (
              <span title={stateReason ?? undefined} className={`cursor-help ${ACCOUNT_STATE_DANGER_STAMP}`}>
                {row.stateRefusal.stamp}
              </span>
            )}
            {row.warning != null && (
              <span title={row.warning} className={`cursor-help ${WARN_STAMP}`}>
                {AUTO_BRACKET_STAMP}
              </span>
            )}
          </p>
          {row.refusal == null && (
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">{describeAccountSummary(row)}</p>
          )}
          {/* Said once here rather than under every box it greys. */}
          {stateReason != null && (
            <p className="mt-1 max-w-2xl text-[11px] leading-snug text-[var(--warning)]">{stateReason}</p>
          )}
          {move && row.replacements.length > 0 && (
            <div className="mt-1">
              <MoveToReplacement
                token={move.token}
                fromAccountId={row.accountId}
                replacements={row.replacements}
                onMoved={move.onMoved}
              />
            </div>
          )}
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-x-5 gap-y-2 sm:w-auto">
          {row.risk.kind !== "silent" && (
            <span className="mr-auto inline-flex items-center gap-2 sm:mr-0">
              <Link
                href={RISK_PAGE_HREF}
                className="text-[11px] text-[var(--muted)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
              >
                {BOOK_RISK_LABEL}
              </Link>
              <RiskCell risk={maskRiskBalance(row.risk, hideBalances)} />
            </span>
          )}
          <span className="hidden sm:contents">{bookSwitch}</span>
          <ActionMenu label={ACCOUNT_MENU_LABEL} items={items} busy={busy} />
        </div>
      </header>
      {/* A refused account draws no boxes: the stamp says it, once. */}
      {row.refusal == null && open && (
        <ContractColumns
          contracts={row.contracts}
          empty={BOOK_NO_PLAYBOOKS}
          renderCell={(cell) => (
            <PlaybookCheckbox
              checked={cell.armed}
              tone={cell.tone}
              label={cell.label}
              title={shield(cell.title)}
              inert={cellToggleIntent(row, cell).kind === "inert"}
              busy={busy}
              stamps={[
                ...(cell.kind === "held" || cell.kind === "idle" ? [cell.kind] : []),
                ...(cell.kind === "unavailable" ? [BOOK_CELL_NOT_IN_BUILD_STAMP] : []),
              ]}
              notes={[
                ...(cell.inlineRefusal != null ? [shield(cell.inlineRefusal)] : []),
                ...(cell.fitWarning != null ? [cell.fitWarning] : []),
              ]}
              onToggle={() => pressCell(row, cell, onToggleCell)}
            />
          )}
        />
      )}
    </section>
  );
}
