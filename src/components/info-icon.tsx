"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Click-triggered tooltip for field descriptions.
 * Click toggles open; outside-click, second click, or × dismisses.
 * Used by ParamField labels and FilterRow input labels.
 */
export function InfoIcon({ description }: { description: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="Field help"
        onClick={() => setOpen((o) => !o)}
        className="w-4 h-4 flex items-center justify-center rounded-full
                   text-[var(--muted)] hover:text-[var(--foreground)]
                   hover:bg-[var(--card-border)] transition-colors leading-none
                   focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="5.5" stroke="currentColor" />
          <text
            x="6"
            y="9"
            textAnchor="middle"
            fontSize="7"
            fill="currentColor"
            fontFamily="monospace"
          >
            i
          </text>
        </svg>
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-50 bottom-full left-0 mb-2
                     w-[260px] max-w-[min(260px,calc(100vw-32px))]
                     bg-[var(--card)] border border-[var(--card-border)]
                     rounded-md px-3 py-2 text-xs text-[var(--foreground)]
                     leading-relaxed shadow-[0_4px_16px_oklch(0_0_0/0.4)]"
        >
          <span className="space-y-2 block">
            {description.split("\n\n").map((para, i) => (
              <span key={i} className="block">{para}</span>
            ))}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setOpen(false)}
            className="absolute top-1 right-1 w-4 h-4 flex items-center
                       justify-center text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            ×
          </button>
        </div>
      )}
    </span>
  );
}
