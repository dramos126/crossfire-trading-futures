"use client";

import { useSystemHealth } from "@/lib/hooks/use-system-health";

/**
 * Slide-down amber banner that appears between TopNav and content
 * whenever the system needs operator attention: REST disconnected,
 * auth error, or engine market hub kicked into passive mode without
 * auto-retry. Non-blocking — pushes content down rather than overlaying.
 */
export function SystemWarningBar() {
  const { warning } = useSystemHealth();
  if (!warning) return null;

  return (
    <div
      role="alert"
      className="amber-breath bg-[var(--amber-bg)] border-y border-[var(--amber-border)]"
    >
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3 sm:gap-4">
        <span className="px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider bg-[var(--amber-text)]/15 text-[var(--amber-text)] border border-[var(--amber-text)]/30 shrink-0">
          {warning.title}
        </span>
        <p className="flex-1 text-xs text-[var(--amber-text)]/90 leading-snug">
          {warning.message}
        </p>
        <button
          type="button"
          onClick={() => void warning.onAction()}
          disabled={warning.busy}
          className="shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--amber-text)]/10 hover:bg-[var(--amber-text)]/20 text-[var(--amber-text)] border border-[var(--amber-text)]/40 transition-colors disabled:opacity-50 shadow-[0_0_12px_rgba(251,146,60,0.35)]"
        >
          {warning.busy ? "Working…" : warning.action}
        </button>
      </div>
    </div>
  );
}
