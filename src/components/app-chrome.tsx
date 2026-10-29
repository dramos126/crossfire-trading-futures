"use client";

import { TopNav } from "@/components/top-nav";
import { SystemWarningBar } from "@/components/system-warning-bar";
import { StatusRail } from "@/components/status-rail";
import { SignInForm } from "@/components/sign-in/sign-in-form";
import { NoBrokerBanner } from "@/components/settings/no-broker";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * The shared chrome, with no gate in front of it: sticky TopNav, the
 * SystemWarningBar (which renders only when there is something to act on),
 * the centered 1200px content well, and the fixed bottom StatusRail.
 *
 * **This is half of what used to be `AppShell`, and the split is the
 * invariant rather than a tidy.** The page `<SetupGuard>` redirects to must
 * never be wrapped by the guard, or the redirect never terminates. Expressing
 * that as a path allowlist inside the guard — *this one route is exempt* —
 * rots the first time a route is renamed, and this guard is what stands
 * between a half-configured install and a dashboard. Composing the chrome
 * directly, without the guard, makes being unguarded structural: there is no
 * rule to keep in sync because there is no guard mounted.
 *
 * Every other page goes through `AppShell`, which is this plus the guard.
 *
 * The `pb-*` on `<main>` reserves room for the rail so the last row of any
 * page is not hidden behind it, and the small-breakpoint pair shrinks with
 * the rail — see `TopNav` for the mobile chrome budget.
 */
export function AppChrome({ children }: { children: React.ReactNode }) {
  const { status } = useTrading();
  // First run is one screen with nothing around it: no account exists, so no
  // page but Settings' setup card can render, and a nav to pages that bounce
  // back here would read as broken. The screen carries the logo itself.
  if (status === "needsSetup") {
    return (
      <main className="min-h-screen">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-8 sm:py-12">{children}</div>
      </main>
    );
  }
  return (
    <div className="min-h-screen flex flex-col">
      <TopNav />
      <SystemWarningBar />
      <NoBrokerBanner />
      <main className="flex-1 pb-10 sm:pb-12">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-5 sm:py-8">
          {/* In place of the page, not over it: every page — Settings
              included — renders here, so a signed-out browser reaches none
              of them, and nothing redirects, so nothing can loop. */}
          {status === "signedOut" ? <SignInForm /> : children}
        </div>
      </main>
      <StatusRail />
    </div>
  );
}
