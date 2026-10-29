"use client";

import { useEffect, useState } from "react";
import { Chevron } from "@/components/chevron";
import { PulseDot } from "@/components/pulse-dot";

interface CollapsibleSectionProps {
  title: string;
  /** Right-side header content (counts, summaries, action buttons). */
  rightSlot?: React.ReactNode;
  /** Default open state. Persists via localStorage if `storageKey` is set. */
  defaultOpen?: boolean;
  /** Pass to persist open/closed across reloads. Omit for ephemeral state. */
  storageKey?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Render a small pulsing accent dot next to the title when the
   *  section's contents are "active" (e.g. at least one filter inside
   *  Filters is enabled). Glance-test affordance for collapsed
   *  sections so the operator knows something is on without expanding. */
  hasActive?: boolean;
  /** When hasActive is true, show a count badge alongside the dot.
   *  Pass the number of enabled toggles in the section. */
  activeCount?: number;
  /** Optional controlled-mode pair. When `open` is provided the
   *  section reads/writes through `onOpenChange` instead of internal
   *  state — used when a parent action (e.g. "Run Backtest" from the
   *  sticky footer) needs to force-open the section. Storage
   *  persistence is bypassed in controlled mode. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Header-row + chevron section used by the strategy detail page (and
 * any other page that needs the deployment-card collapse pattern).
 * Persistence is opt-in: callers pass a `storageKey` to remember
 * collapse state across reloads. Defaults are honored on first mount;
 * stored values win after that.
 */
export function CollapsibleSection({
  title,
  rightSlot,
  defaultOpen = true,
  storageKey,
  className = "",
  hasActive,
  activeCount,
  open: controlledOpen,
  onOpenChange,
  children,
}: CollapsibleSectionProps) {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : internalOpen;

  useEffect(() => {
    if (isControlled) return;
    if (!storageKey) return;
    const stored = localStorage.getItem(storageKey);
    if (stored != null) setInternalOpen(stored === "true");
  }, [storageKey, isControlled]);

  const toggle = () => {
    const next = !open;
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setInternalOpen(next);
      if (storageKey) localStorage.setItem(storageKey, String(next));
    }
  };

  // Root is a div with role="button" rather than a real <button> so
  // callers can drop interactive controls into rightSlot (e.g. a
  // Deploy button) without nesting <button> in <button>, which React
  // hydration rejects.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div className={`border-b border-[var(--card-border)] last:border-0 ${className}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={onKeyDown}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left hover:bg-[var(--hover)] transition-colors cursor-pointer select-none"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[var(--muted)] inline-flex items-center">
            <Chevron expanded={open} />
          </span>
          <span className="text-sm font-semibold text-[var(--foreground)]">
            {title}
          </span>
          {hasActive && (
            <span className="flex items-center gap-1" aria-label={`${activeCount ?? 1} active`}>
              <PulseDot
                active
                color="bg-[var(--accent)]"
                label="Active logic in this section"
              />
              {activeCount != null && activeCount > 0 && (
                <span className="text-xs font-mono text-[var(--accent)] tabular-nums leading-none">
                  {activeCount}
                </span>
              )}
            </span>
          )}
        </div>
        {rightSlot && (
          <div onClick={(e) => e.stopPropagation()} className="shrink-0">
            {rightSlot}
          </div>
        )}
      </div>
      {open && <div className="px-5 pb-5 pt-3 bg-[var(--bg)]">{children}</div>}
    </div>
  );
}
