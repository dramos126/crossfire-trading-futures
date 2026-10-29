"use client";

import { useEffect, useRef, useState } from "react";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { parseSettingsBundle } from "@/lib/settings/parse-bundle";

export const NOTIFICATIONS_LABEL = "Notifications";

/**
 * Discord notifications kill-switch in the TopNav. Persisted server-side
 * (app_settings.notifications_enabled) so the engine sees the same flag
 * across browser refreshes and container redeploys. Off by default — a
 * fresh deploy stays quiet until the operator opts in.
 *
 * `showLabel={false}` drops the visible word for a caller whose row already
 * names the switch (the phone menu); the switch keeps it as its accessible name.
 */
export function NotificationsToggle({ showLabel = true }: { showLabel?: boolean } = {}) {
  const { token } = useTrading();
  const [enabled, setEnabled] = useState<boolean>(false);
  const [loaded, setLoaded] = useState<boolean>(false);
  // Suppress CSS transitions until one frame after the initial server
  // state has loaded. Otherwise tab-switch remounts the component, fetch
  // flips off→on, and the toggle visibly animates every time. Re-enabling
  // on the next frame ensures user-driven toggles still animate normally.
  const [animate, setAnimate] = useState<boolean>(false);
  const animateTimer = useRef<number | null>(null);

  // Initial fetch once we have a token. Without it the gated route 401s.
  // Reads the full /api/settings bundle and picks notificationsEnabled
  // off it — same store as the Settings page, so toggle changes from
  // either surface land in the same DB row.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        const data: unknown = await res.json();
        if (!cancelled && res.ok) {
          const parsed = parseSettingsBundle(data);
          if (!("error" in parsed)) {
            setEnabled(parsed.notificationsEnabled);
          }
        }
      } catch {
        // transient — leave the toggle in its default-off state
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Enable transitions one frame after the initial value lands, so the
  // mount→loaded paint snaps to the correct position without animating.
  useEffect(() => {
    if (!loaded) return;
    animateTimer.current = window.requestAnimationFrame(() => setAnimate(true));
    return () => {
      if (animateTimer.current != null) cancelAnimationFrame(animateTimer.current);
    };
  }, [loaded]);

  const toggle = async () => {
    if (!token) return;
    const next = !enabled;
    setEnabled(next); // optimistic
    try {
      // Partial-bundle PUT — only `notificationsEnabled` is sent so the
      // route leaves the other settings untouched. Server returns the
      // full post-write bundle but we keep the optimistic local state on
      // success (avoids a flicker if the confirmed value matches).
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationsEnabled: next }),
      });
      if (!res.ok) setEnabled(!next); // rollback
    } catch {
      setEnabled(!next);
    }
  };

  const disabled = !token || !loaded;

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      role="switch"
      aria-checked={enabled}
      aria-label={showLabel ? undefined : NOTIFICATIONS_LABEL}
      disabled={disabled}
      title={
        enabled
          ? "Notifications ON — engine posts trade + connection alerts to Discord"
          : "Notifications OFF — Discord webhooks suppressed engine-wide"
      }
      className="flex items-center gap-2 group disabled:opacity-50"
    >
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border ${
          animate ? "transition-colors" : ""
        } ${
          enabled
            ? "bg-[var(--success)]/20 border-[var(--success)]"
            : "bg-[var(--hover)] border-[var(--card-border)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full ${
            animate ? "transition-all" : ""
          } ${
            enabled
              ? "left-[18px] bg-[var(--success)] shadow-[0_0_6px_rgba(34,197,94,0.6)]"
              : "left-0.5 bg-[var(--muted)]"
          }`}
        />
      </span>
      {showLabel && (
        <span
          className={`text-xs font-medium ${animate ? "transition-colors" : ""} ${
            enabled ? "text-[var(--success)]" : "text-[var(--muted)] group-hover:text-[var(--foreground)]"
          }`}
        >
          {NOTIFICATIONS_LABEL}
        </span>
      )}
    </button>
  );
}
