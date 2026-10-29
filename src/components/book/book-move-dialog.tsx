"use client";

import { useEffect, useRef, useState } from "react";
import {
  moveGroups,
  CANCEL_LABEL,
  MOVE_CONFIRM,
  MOVE_DIALOG_TITLE,
  MOVE_PREVIEW_CHANGED,
  MOVE_WILL_CLOSE,
  type BookGridRow,
} from "@/components/book/book-grid-model";
import {
  BookDialog,
  DIALOG_LABEL,
  PickList,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "@/components/book/book-controls";
import type { MovePreview } from "@/app/api/books/[id]/move/route";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";

/**
 * The Move dialog: pick the book, read what the move does — *Keeps running*,
 * *Stops* (a position it closes named per playbook), *Starts* — then *Move*.
 * The lists are `GET /api/books/[id]/move?to=`, the planner the write runs, so
 * the dialog cannot promise a move the route refuses; a refusal there blocks
 * the whole move and is printed verbatim. The press reads it again and moves
 * only if the answer still matches the lists on screen.
 */

export interface MoveDialogProps {
  row: BookGridRow;
  targets: ReadonlyArray<{ id: string; name: string }>;
  /** The book the ⋯ item opened the dialog on. */
  initialTarget: string;
  /** The confirmation's read. A failed read answers with its sentence as the refusal. */
  preview: (bookId: string, targetId: string) => Promise<MovePreview>;
  /** Playbook display names, for the lists. */
  nameOf: (strategyKey: string) => string;
  busy: boolean;
  /** The move route's refusal, verbatim, when the press was refused. */
  refusal: string | null;
  /** Resolves true once the move is written. */
  onMove: (row: BookGridRow, targetId: string) => Promise<boolean>;
  onClose: () => void;
}

/** The Move press: a read that has answered for the picked book, with no refusal in it. */
export function moveIntent(preview: MovePreview | null): "write" | "inert" {
  return preview != null && preview.refusal == null ? "write" : "inert";
}

/** Whether two reads of the move say the same thing, line for line. */
export function samePreview(a: MovePreview, b: MovePreview): boolean {
  return (
    a.refusal === b.refusal &&
    a.lines.length === b.lines.length &&
    a.lines.every((l, i) => {
      const m = b.lines[i];
      return l.ticker === m.ticker && l.strategyKey === m.strategyKey && l.step === m.step && l.willClose === m.willClose;
    })
  );
}

export function MoveDialog({
  row,
  targets,
  initialTarget,
  preview,
  nameOf,
  busy,
  refusal,
  onMove,
  onClose,
}: MoveDialogProps) {
  const { accountLabel } = useDisplayPrivacy();
  const [target, setTarget] = useState(initialTarget);
  const [read, setRead] = useState<{ target: string; preview: MovePreview } | null>(null);
  const [checking, setChecking] = useState(false);
  const [changed, setChanged] = useState(false);
  const pressing = useRef(false);

  // Keyed on the account's book id, not the row: the row is rebuilt on every
  // refetch and risk tick, and none of that changes what the move would do.
  const bookId = row.id;
  useEffect(() => {
    let live = true;
    void preview(bookId, target).then((answer) => {
      if (live) setRead({ target, preview: answer });
    });
    return () => {
      live = false;
    };
  }, [preview, bookId, target]);

  // A read for the book picked before this one says nothing about this one.
  const current = read?.target === target ? read.preview : null;
  const locked = busy || checking;

  const press = async () => {
    if (pressing.current || current == null || moveIntent(current) !== "write") return;
    pressing.current = true;
    setChecking(true);
    try {
      const fresh = await preview(bookId, target);
      if (!samePreview(fresh, current)) {
        setRead({ target, preview: fresh });
        setChanged(true);
        return;
      }
      setChanged(false);
      if (await onMove(row, target)) onClose();
    } finally {
      pressing.current = false;
      setChecking(false);
    }
  };

  return (
    <BookDialog
      title={MOVE_DIALOG_TITLE}
      busy={locked}
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={locked} className={SECONDARY_BUTTON}>
            {CANCEL_LABEL}
          </button>
          <button
            type="button"
            disabled={locked || moveIntent(current) !== "write"}
            title={current?.refusal ?? undefined}
            onClick={() => void press()}
            className={PRIMARY_BUTTON}
          >
            {MOVE_CONFIRM}
          </button>
        </>
      }
    >
      <p className="font-mono tabular text-xs text-[var(--foreground)]">{accountLabel(row.title)}</p>
      <PickList
        name="move-book"
        value={target}
        onPick={(id) => {
          if (locked) return;
          setChanged(false);
          setTarget(id);
        }}
        options={targets.map((t) => ({
          value: t.id,
          disabled: locked,
          content: <span className="text-sm font-semibold text-[var(--foreground)]">{t.name}</span>,
        }))}
      />
      {current == null ? (
        <p className="text-[11px] text-[var(--muted)]">…</p>
      ) : (
        moveGroups(current.lines, row.enabled).map((group) => (
          <div key={group.step}>
            <p className={DIALOG_LABEL}>{group.heading}</p>
            <ul className="overflow-hidden rounded-md border border-[var(--card-border)] text-xs">
              {group.lines.map((line, idx) => (
                <li
                  key={`${line.ticker}:${line.strategyKey}`}
                  className={`flex flex-wrap gap-x-2 px-3 py-1.5 ${idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"}`}
                >
                  <span className="text-[var(--foreground)]">{nameOf(line.strategyKey)}</span>
                  <span className="font-mono tabular text-[var(--muted)]">{line.ticker}</span>
                  {line.willClose && <span className="text-[var(--warning)]">{MOVE_WILL_CLOSE}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {(changed ? [MOVE_PREVIEW_CHANGED] : [])
        .concat(current?.refusal != null ? [current.refusal] : [])
        .concat(refusal != null ? [refusal] : [])
        .map((sentence, idx) => (
          <p
            key={idx}
            className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]"
          >
            {sentence}
          </p>
        ))}
    </BookDialog>
  );
}
