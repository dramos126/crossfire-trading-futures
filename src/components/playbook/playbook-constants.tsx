"use client";

import { useState } from "react";
import { Chevron } from "@/components/chevron";
import {
  CONSTANTS_HELP,
  describeConstants,
  OFF_STAMP_REASON,
  type PlaybookConstantRow,
} from "@/components/playbook/playbook-detail-model";
import { PlaybookSection } from "@/components/playbook/playbook-section";

/**
 * The *Constants* frame: what this playbook runs at, the range each value is
 * allowed to move in, and why it sits where it does.
 *
 * **Every rationale renders inline, expanded by a `Chevron`, never behind a
 * dropdown or a tooltip.** This is the param form's rule — *a control that
 * has to be discovered is a control that will not be used* — applied to a
 * reading rather than a control. A tooltip is the wrong instrument twice
 * over: `maxStopTicks`' rationale is seven hundred words, and the collapsed
 * row already carries the clause a tooltip would have shown, because the
 * first clause of every one of these is the verdict.
 *
 * Rows expand independently. Reading one constant against another is the
 * common case, and a single-open accordion makes that two round trips.
 */
export function PlaybookConstantsSection({ rows }: { rows: readonly PlaybookConstantRow[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (name: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <PlaybookSection
      title="Constants"
      help={CONSTANTS_HELP}
      right={<span className="font-mono tabular">{describeConstants(rows)}</span>}
    >
      <div className="grid grid-cols-[16px_11rem_6rem_9rem_minmax(0,1fr)] items-center gap-x-3 border-b border-[var(--card-border)] px-2 py-1.5 text-[10px] uppercase tracking-wider text-[var(--muted)]">
        <span aria-hidden />
        <span>Name</span>
        <span>Value</span>
        <span>Range</span>
        <span>Why</span>
      </div>
      {rows.map((row, idx) => (
        <ConstantRow
          key={row.name}
          row={row}
          idx={idx}
          expanded={open.has(row.name)}
          onToggle={() => toggle(row.name)}
        />
      ))}
    </PlaybookSection>
  );
}

function ConstantRow({
  row,
  idx,
  expanded,
  onToggle,
}: {
  row: PlaybookConstantRow;
  idx: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const zebra = idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]";
  return (
    <div className={zebra}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[16px_11rem_6rem_9rem_minmax(0,1fr)] items-center gap-x-3 px-2 py-1.5 text-left transition-colors hover:bg-[var(--hover)]"
      >
        <Chevron expanded={expanded} className="text-[var(--muted)]" />
        <span className="truncate font-mono text-xs text-[var(--foreground)]">{row.name}</span>
        <span className="flex items-center gap-1.5 font-mono tabular text-xs text-[var(--foreground)]">
          {row.value}
          {row.atOffValue && (
            <span
              title={OFF_STAMP_REASON}
              className="rounded-sm border border-[var(--card-border)] px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]"
            >
              off
            </span>
          )}
        </span>
        <span className="truncate font-mono tabular text-xs text-[var(--muted)]">
          {row.rangeLabel}
        </span>
        {/* The collapsed line is the first clause, cut by the column rather
            than by a character budget — nothing here invents a length. */}
        <span className="truncate text-[11px] text-[var(--muted)]">{row.rationale}</span>
      </button>
      {expanded && (
        <p className="bg-[var(--bg-row-deep)] px-2 py-3 pl-[31px] text-xs leading-relaxed text-[var(--muted)]">
          {row.segments.map((segment, i) =>
            segment.emphasis ? (
              <strong key={i} className="font-semibold text-[var(--foreground)]">
                {segment.text}
              </strong>
            ) : (
              <span key={i}>{segment.text}</span>
            ),
          )}
        </p>
      )}
    </div>
  );
}
