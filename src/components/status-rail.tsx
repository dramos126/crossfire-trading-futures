"use client";

import Link from "next/link";
import { useSystemHealth } from "@/lib/hooks/use-system-health";
import { isProductionEnv } from "@/lib/env";
import { PulseDot } from "@/components/pulse-dot";

/**
 * Fixed bottom rail — 28px on a phone, 32px from `sm` up. Carries the same
 * system-health detail string the sidebar used to surface ("stream · engine
 * hub realtime", etc.) but tucked at the floor so it never competes with the
 * workspace. The TopNav pill is the headline; this is the footnote.
 *
 * The env pill and build stamp drop below `sm` — they answer *what am I
 * running*, which is a desk question. **The health cluster does not drop: it
 * is the link to `/logs`, so losing it on a phone would strand the page.**
 */
// Baked in at build time via NEXT_PUBLIC_BUILD_SHA in the Dockerfile +
// --build-arg BUILD_SHA=<commit> from the deploy pipeline. Defaults to
// "dev" for local `npm run dev` where no build arg is set.
const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA || "dev";
// Build-time env stamp. Any non-prod env renders an env pill so the
// operator can spot at a glance which env this tab is pointed at.
// Falls back to "dev" for local `npm run dev` where NEXT_PUBLIC_APP_ENV
// is unset.
const APP_ENV_LABEL = process.env.NEXT_PUBLIC_APP_ENV ?? "dev";
const IS_NON_PROD = !isProductionEnv();

export function StatusRail() {
  const { detail, pillLabel, pillTone, pulsing } = useSystemHealth();

  const dotColor =
    pillTone === "ok"
      ? "bg-[var(--success)]"
      : pillTone === "warn"
        ? "bg-[var(--warning)]"
        : "bg-[var(--danger)]";

  return (
    <footer className="fixed bottom-0 inset-x-0 z-20 h-7 sm:h-8 bg-[var(--sidebar)] border-t border-[var(--sidebar-border)]">
      <div className="h-full max-w-[1200px] mx-auto px-4 sm:px-6 flex items-center gap-3 text-[11px] text-[var(--muted)]">
        {/* The health cluster is the app's only global route to `/logs`, and
            the mapping is direct: this line *is* the system state, so the log
            behind it is the claim's evidence. It is deliberately not placed
            beside the build stamp — the env pill and the sha answer *what am
            I running*, which is identity rather than action.

            The rail is a footnote by design, so the affordance has to be
            visibly one: a nav tab traded for an unmarked footnote is a
            regression dressed as a simplification. Hence the hover lift on
            both the label and the detail, the pointer, and the `title=`. */}
        <Link
          href="/logs"
          title="Open the engine log behind this status"
          className="group flex min-w-0 items-center gap-3 rounded-md px-1 -mx-1 hover:bg-[var(--hover)] transition-colors"
        >
          <PulseDot
            active={pulsing}
            color={dotColor}
            label={pillLabel}
          />
          <span className="text-[var(--foreground)]/70 group-hover:text-[var(--foreground)] transition-colors">
            {pillLabel}
          </span>
          {detail && (
            <>
              <span className="text-[var(--muted)]/40">·</span>
              <span className="truncate tabular group-hover:text-[var(--foreground)] transition-colors">
                {detail}
              </span>
            </>
          )}
          <span className="shrink-0 text-[var(--muted-secondary)] group-hover:text-[var(--accent)] transition-colors">
            ↗ logs
          </span>
        </Link>
        {IS_NON_PROD && (
          <span
            className="hidden sm:inline ml-auto px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wider bg-[var(--amber-bg)] text-[var(--amber-text)] border border-[var(--amber-border)] shrink-0"
            title={`Running on ${APP_ENV_LABEL}`}
          >
            {APP_ENV_LABEL}
          </span>
        )}
        <span
          className={`hidden sm:inline ${IS_NON_PROD ? "" : "ml-auto"} font-mono text-[10px] text-[var(--muted)]/60 shrink-0`}
          title="Build commit"
        >
          build {BUILD_SHA}
        </span>
      </div>
    </footer>
  );
}
