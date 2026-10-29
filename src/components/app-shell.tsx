"use client";

import { AppChrome } from "@/components/app-chrome";
import { SetupGuard } from "@/components/setup-guard";

/**
 * The guard plus the chrome — what every page except the one the guard
 * redirects to renders inside.
 *
 * `<SetupGuard>` intercepts the render when the install is not configured and
 * redirects. Its target composes `<AppChrome>` directly instead of this
 * component, so the guard can never wrap the page it would redirect to; that
 * pairing is what keeps the redirect from looping, and `app-chrome.tsx` holds
 * the reasoning for why it is a split rather than an exemption.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SetupGuard>
      <AppChrome>{children}</AppChrome>
    </SetupGuard>
  );
}
