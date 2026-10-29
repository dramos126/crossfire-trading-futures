"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * Destructive reset card — the whole of the Settings page `/settings/danger-zone`.
 * Pattern matches GitHub/Vercel "Danger Zone" sections — distinct red
 * border, two-step typed-confirmation modal, hard wipe of creds +
 * deployments + tombstones + trades on confirm.
 *
 * After a successful reset the client navigates to /settings, which is where
 * first run lives — Settings comes back as a first run because the reset
 * cleared `setup_confirmed_at`. The engine keeps running on stale in-memory
 * state until the next /api/auth tick discovers `needsSetup` and the natural
 * passive-no-creds path takes over.
 */
export function DangerZone() {
  const { token } = useTrading();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc closes the modal. Prevents the modal becoming a trap when the
  // operator changes their mind.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, submitting]);

  function closeModal() {
    setOpen(false);
    setConfirmInput("");
    setError(null);
  }

  async function onConfirm() {
    if (!token) return;
    if (confirmInput !== "RESET") return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Reset failed (${res.status})`);
        return;
      }
      router.replace("/settings");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="premium-card bg-[var(--card)] border-[var(--danger)]/40 p-5 space-y-4">
        <h2 className="text-sm font-semibold tracking-tight text-[var(--danger)] pb-2 border-b border-[var(--danger)]/30">
          Danger Zone
        </h2>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm text-[var(--foreground)] font-medium">
              Reset configuration
            </div>
            <div className="text-xs text-[var(--muted)]">
              Wipes Topstep credentials, webhook URL, all deployments, and trade
              history. The engine returns to first-run setup.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="px-4 py-2 rounded-md text-sm font-medium border border-[var(--danger)]/60 text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors whitespace-nowrap"
          >
            Reset…
          </button>
        </div>
      </section>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !submitting) closeModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-modal-title"
            className="w-full max-w-md premium-card bg-[var(--card)] border-[var(--danger)]/50 p-5 space-y-4"
          >
            <h3
              id="reset-modal-title"
              className="text-base font-semibold tracking-tight text-[var(--danger)]"
            >
              Reset configuration
            </h3>
            <div className="text-sm text-[var(--foreground)] space-y-2">
              <p>This will permanently delete:</p>
              <ul className="list-disc pl-5 space-y-1 text-xs text-[var(--muted)]">
                <li>Topstep username, API key, and webhook URL</li>
                <li>All deployments (including disabled and trashed)</li>
                <li>All historical trades and their bar snapshots</li>
                <li>The cached auth token</li>
              </ul>
              <p className="text-xs text-[var(--muted)]">
                Open broker positions are NOT closed. The engine drops to
                passive-no-creds; flatten any open positions in Topstep
                directly if needed.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[var(--muted)] uppercase tracking-wider">
                Type <span className="font-mono text-[var(--danger)]">RESET</span> to confirm
              </label>
              <input
                type="text"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={submitting}
                autoFocus
                className="w-full border border-[var(--card-border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--danger)] rounded-md disabled:opacity-50"
              />
            </div>
            {error && (
              <div className="border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-xs font-mono text-[var(--danger)] rounded-md">
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                className="px-4 py-2 rounded-md text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onConfirm()}
                disabled={submitting || confirmInput !== "RESET"}
                className="px-4 py-2 rounded-md text-sm font-medium border border-[var(--danger)]/60 bg-[var(--danger)]/15 text-[var(--danger)] hover:bg-[var(--danger)]/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? "Resetting…" : "Confirm reset"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
