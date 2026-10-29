"use client";

import { useId, useState } from "react";
import { Chevron } from "@/components/chevron";
import { InfoIcon } from "@/components/info-icon";

/**
 * One frame on the Playbooks detail page: an uppercase header with its
 * `InfoIcon`, a right-hand summary, and a body.
 *
 * **Not a `CollapsibleSection`.** That primitive is for a surface where the
 * operator is working and needs the density back — a param form, a backtest
 * panel. This page is a reading, and a collapsed *Admission* frame hides the
 * only thing the page exists to say. Nothing here is behind a disclosure the
 * operator has to find, which is the param form's rule applied to a reading.
 *
 * `collapsible` is for the one frame that is a working surface, *Try
 * settings*: closed on every load, and the body is hidden rather than
 * unmounted, so a run in flight and its result survive a close.
 */
export function PlaybookSection({
  title,
  help,
  right,
  collapsible = false,
  children,
}: {
  title: string;
  help: string;
  right?: React.ReactNode;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible);
  const bodyId = useId();
  const heading = (
    <h3 className="text-xs font-semibold uppercase tracking-widest text-[var(--foreground)]">
      {title}
    </h3>
  );
  return (
    <section className="border border-[var(--card-border)] bg-[var(--card)]">
      <header
        className={`flex items-center justify-between gap-3 px-4 py-2 ${
          open ? "border-b border-[var(--card-border)]" : ""
        }`}
      >
        <div className="flex items-center gap-2">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2 text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <Chevron expanded={open} />
              {heading}
            </button>
          ) : (
            heading
          )}
          <InfoIcon description={help} />
        </div>
        {right && (
          <span className="shrink-0 text-[11px] text-[var(--muted)]">{right}</span>
        )}
      </header>
      <div id={bodyId} hidden={!open} className="px-4 py-3">
        {children}
      </div>
    </section>
  );
}
